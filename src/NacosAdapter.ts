import {
    application,
    bootstrap as neaBootstrap,
    BootstrapOptions,
    log,
    error as logError,
    deepMerge as neaDeepMerge,
} from 'nea-boot';
import { NacosConfigCenter, deepMergeNacos } from './config/NacosConfigCenter';
import { NacosRegistry } from './registry/NacosRegistry';
import { NacosOptions, NacosStatus } from './types';

/**
 * Nacos 适配器 —— 把配置中心与注册中心接入 nea-boot 的启动流程
 *
 * ## 启动顺序（关键）
 *
 * ```
 * 1. NacosConfigCenter.load()      ← 先把远端配置拉回来
 * 2. 合并进 ConfigManager.config   ← 让 @Value 能读到
 * 3. neaBootstrap()                ← 正常启动（内部会读 config 注入 @Value）
 * 4. NacosRegistry.register()      ← 端口已在监听，此时注册最安全
 * ```
 *
 * 第 4 步必须在 `bootstrap()` 之后：Nacos 一旦有实例就会导流过来，
 * 若端口还没监听会直接报错。
 *
 * ## 使用方式
 *
 * ```ts
 * import { NacosAdapter } from 'nea-boot-cloud-nacos';
 *
 * const nacos = new NacosAdapter({
 *   serverAddr: '127.0.0.1:8848',
 *   namespace: 'dev',
 *   configs: [
 *     { dataId: 'application.yml' },
 *     { dataId: 'my-service.yml', required: true },
 *   ],
 *   serviceName: 'my-service',
 * });
 *
 * await nacos.start();
 * ```
 *
 * 也可以接装饰器启动方式：在 `@EnableApplication` 之前先 `await nacos.loadConfig()`。
 */
export class NacosAdapter {
    private options: NacosOptions;
    private configCenter: NacosConfigCenter;
    private registry: NacosRegistry;
    private status: NacosStatus = {
        configLoaded: false,
        loadedDataIds: [],
        registered: false,
        instance: null,
        lastError: null,
    };
    private started = false;

    constructor(options: NacosOptions) {
        this.options = options;
        this.configCenter = new NacosConfigCenter(options);
        this.registry = new NacosRegistry(options);
    }

    private get logPrefix(): string {
        return '[nacos]';
    }

    /**
     * 只加载配置，不启动应用。
     *
     * 用于「装饰器启动」场景：在 `@EnableApplication` 生效前把远端配置拉回来。
     *
     * ```ts
     * const nacos = new NacosAdapter({ configs: [...] });
     * await nacos.loadConfig();
     *
     * @EnableApplication({ port: 3000, scanPath: ['/src'] })
     * class App {}
     * ```
     */
    async loadConfig(): Promise<Record<string, any>> {
        const hasConfigs = (this.options.configs?.length ?? 0) > 0;
        if (!hasConfigs) {
            log(`${this.logPrefix} 未声明 configs，跳过配置中心`);
            return {};
        }

        try {
            const remote = await this.configCenter.load();
            this.applyToConfigManager(remote);

            this.status.configLoaded = true;
            this.status.loadedDataIds = this.configCenter.getLoadedDataIds();
            this.status.lastError = null;

            log(`${this.logPrefix} 配置已合并，共 ${this.status.loadedDataIds.length} 项`);
            return remote;
        } catch (e) {
            this.status.lastError = (e as Error).message;
            throw e;
        }
    }

    /**
     * 把远端配置合并进 nea-boot 的 `ConfigManager.config`。
     *
     * 优先级：**远端覆盖本地**（本地 `Application.yml` 作为兜底）。
     * 这是配置中心的常规语义——发布到 Nacos 的值应最终生效。
     */
    private applyToConfigManager(remote: Record<string, any>): void {
        if (!remote || Object.keys(remote).length === 0) return;

        const cm = (application as any).configManager;
        if (!cm) {
            logError(`${this.logPrefix} 找不到 configManager，配置未生效`);
            return;
        }

        const merged = deepMergeNacos(cm.config || {}, remote);
        cm.config = merged;
    }

    /**
     * 完整启动：加载配置 → 启动 nea-boot → 注册到 Nacos
     *
     * @param bootstrapOptions 传给 nea-boot 的启动参数
     */
    async start(bootstrapOptions?: BootstrapOptions): Promise<void> {
        if (this.started) {
            log(`${this.logPrefix} 已启动，跳过`);
            return;
        }

        // 1. 配置
        await this.loadConfig();

        // 2. 启动应用（内部会读 configManager.config 注入 @Value）
        await neaBootstrap(bootstrapOptions);

        // 3. 注册（必须在 listen 成功之后）
        await this.registerSelf();

        // 4. 注册关闭钩子
        this.installShutdownHook();

        this.started = true;
    }

    /**
     * 单独注册（用于已自行 bootstrap 的场景）。
     */
    async registerSelf(): Promise<void> {
        if (!this.options.serviceName) return;

        const actualPort = this.getActualPort();
        try {
            const instance = await this.registry.register(actualPort);
            if (instance) {
                this.status.registered = true;
                this.status.instance = {
                    ip: instance.ip,
                    port: instance.port,
                    serviceName: instance.serviceName,
                };
                this.status.lastError = null;
            }
        } catch (e) {
            this.status.lastError = (e as Error).message;
            // 注册失败是否致命？
            // 生产环境下「注册失败」= 流量进不来，应当视为启动失败。
            throw new Error(`Nacos 注册失败: ${(e as Error).message}`);
        }
    }

    /** 取实际监听的端口（优先用框架记录的，其次用配置的） */
    private getActualPort(): number {
        const app = application as any;
        if (typeof app.appPort === 'number' && app.appPort > 0) return app.appPort;

        const configured = this.options.port;
        if (typeof configured === 'number' && configured > 0) return configured;

        throw new Error(
            '无法确定服务端口。请显式设置 nacos.port，或确保应用已成功启动',
        );
    }

    /**
     * 安装关闭钩子：注销实例 + 关闭 Nacos 客户端。
     *
     * 为什么需要：临时实例靠心跳维持，但如果进程被 SIGTERM 优雅关闭，
     * 主动注销能让流量立刻停止导入，而不是等心跳超时（默认 15s）。
     */
    /** 安装关闭钩子（公开方法，供 bootstrapWithNacos 复用） */
    installShutdownHook(): void {
        const handler = async () => {
            await this.stop();
        };
        process.once('SIGTERM', () => { void handler(); });
        process.once('SIGINT', () => { void handler(); });
    }

    /** 停止：注销 + 关闭客户端 */
    async stop(): Promise<void> {
        try {
            await this.registry.close();
            this.status.registered = false;
        } catch (e) {
            logError(`${this.logPrefix} 注销失败:`, e);
        }
        try {
            await this.configCenter.close();
        } catch (e) {
            logError(`${this.logPrefix} 关闭配置客户端失败:`, e);
        }
    }

    /** 运行时状态（诊断用） */
    getStatus(): NacosStatus {
        return { ...this.status };
    }

    /** 服务发现：查询某个服务的健康实例 */
    async discover(serviceName: string, groupName?: string) {
        return this.registry.getHealthyInstances(serviceName, groupName);
    }
}
