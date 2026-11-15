import { application, bootstrap as neaBootstrap, BootstrapOptions, log, error as logError } from 'nea-boot';
import { NacosAdapter } from './NacosAdapter';
import { NacosOptions } from './types';
import {
    annotationRegistry,
    applyNacosValues,
    refreshNacosValues,
} from './annotations';

/**
 * `bootstrapWithNacos(options?)` —— 注解方式的统一启动入口
 *
 * 它做的事：
 * 1. 从注解登记表读取 `@EnableNacos` / `@NacosConfig` / `@NacosService`
 * 2. 组装成 `NacosOptions`
 * 3. 拉配置 → 合并进 ConfigManager → 启动 nea-boot → 注册 Nacos
 * 4. 应用所有 `@NacosValue`，并在配置变更时刷新它们（热更新）
 *
 * ## 用法
 *
 * ```ts
 * import { EnableApplication } from 'nea-boot';
 * import { EnableNacos, NacosConfig, NacosService, NacosValue, bootstrapWithNacos } from 'nea-boot-cloud-nacos';
 *
 * @EnableNacos({ serverAddr: '127.0.0.1:8848', namespace: 'dev' })
 * @NacosConfig({ dataId: 'application.yml' })
 * @NacosService('my-service')
 * class App {}
 *
 * await bootstrapWithNacos({ port: 3000, scanPath: ['/src'] });
 * ```
 *
 * ## 为什么需要这个函数，而不是让 @EnableNacos 自动启动
 *
 * 类装饰器是**同步**求值的，而 Nacos 配置拉取是**异步**的。
 * 若在 `@EnableNacos` 里直接启动，拿不到配置就已经 bootstrap 完了。
 * 因此必须由一个 async 入口统一编排。
 *
 * `@EnableNacos` 的作用是「登记连接参数」，真正启动由本函数触发。
 */
export async function bootstrapWithNacos(bootstrapOptions?: BootstrapOptions): Promise<NacosAdapter> {
    const enableOpts = annotationRegistry.getEnableOptions();
    const configs = annotationRegistry.getConfigs();
    const services = annotationRegistry.getServices();

    if (!enableOpts && configs.length === 0 && services.length === 0) {
        logError(
            '[nacos] 未检测到任何 Nacos 注解。' +
            '请至少使用 @EnableNacos() 或 @NacosConfig() / @NacosService()。' +
            '现在按普通 nea-boot 启动。',
        );
        await neaBootstrap(bootstrapOptions);
        return new NacosAdapter({});
    }

    // ---- 从注解组装 NacosOptions ----
    const options: NacosOptions = {
        serverAddr: enableOpts?.serverAddr,
        namespace: enableOpts?.namespace,
        username: enableOpts?.username,
        password: enableOpts?.password,
        timeout: enableOpts?.timeout,
        watch: enableOpts?.watch,
        configs,
    };

    // 注册中心：取第一个 @NacosService（Nacos 一个实例只注册一个服务名）
    if (services.length > 0) {
        if (services.length > 1) {
            logError(
                `[nacos] 检测到 ${services.length} 个 @NacosService，` +
                `只会注册第一个（${services[0].name}）。Nacos 单个实例只能注册一个服务名。`,
            );
        }
        const s = services[0];
        options.serviceName = s.name;
        options.groupName = s.groupName;
        options.clusterName = s.clusterName;
        options.weight = s.weight;
        options.ephemeral = s.ephemeral;
        options.ip = s.ip;
        options.port = s.port;
        options.metadata = s.metadata;
    }

    const nacos = new NacosAdapter(options);

    // ---- 包装 onConfigChange：先做热更新，再调用户回调 ----
    const userOnChange = enableOpts?.onConfigChange;
    (options as any).onConfigChange = (merged: Record<string, any>, changed: { dataId: string; content: string }) => {
        try {
            const count = refreshNacosValues(getAllInstances(), merged);
            if (count > 0) {
                log(`[nacos] 配置变更后刷新了 ${count} 个 @NacosValue 字段`);
            }
        } catch (e) {
            logError('[nacos] 热更新 @NacosValue 失败:', e);
        }
        userOnChange?.(merged, changed);
    };

    // ---- 启动流程 ----
    await nacos.loadConfig();
    await neaBootstrap(bootstrapOptions);

    // 首次注入 @NacosValue（在实例化之后、路由可用之前）
    try {
        const count = applyNacosValues(getAllInstances(), (application as any).configManager.config || {});
        if (count > 0) {
            log(`[nacos] 已注入 ${count} 个 @NacosValue 字段`);
        }
    } catch (e) {
        logError('[nacos] 注入 @NacosValue 失败:', e);
    }

    await nacos.registerSelf();
    nacos.installShutdownHook();
    (nacos as any).started = true;

    log('[nacos] 注解模式启动完成');
    return nacos;
}

/** 取当前应用里所有已实例化的组件实例 */
function getAllInstances(): any[] {
    const cm = (application as any).componentManager;
    if (!cm?.componentsOnName) return [];
    const out: any[] = [];
    cm.componentsOnName.forEach((c: any) => {
        if (c?.instance) out.push(c.instance);
    });
    return out;
}

/**
 * `@NacosConfig` 声明的配置项在 `@EnableNacos` 之前被求值也没关系——
 * 登记表是模块级的，与求值顺序无关。
 *
 * 但如果完全不使用注解，又想手动控制，可以直接用 `NacosAdapter`。
 */
export { annotationRegistry } from './annotations';
