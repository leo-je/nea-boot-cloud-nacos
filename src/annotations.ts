import { log, error as logError } from 'nea-boot';
import { NacosConfigItem } from '../types';

/**
 * Nacos 注解（装饰器）支持
 *
 * 提供 4 个装饰器，让使用方式与 nea-boot 的 `@Service` / `@Controller` 一致：
 *
 * | 装饰器 | 作用 |
 * |---|---|
 * | `@EnableNacos(options)` | 类装饰器：声明连接参数并触发启动 |
 * | `@NacosConfig({dataId, group})` | 类装饰器：声明要拉取的配置项 |
 * | `@NacosService({name, group})` | 类装饰器：声明注册到 Nacos 的服务 |
 * | `@NacosValue('key.path')` | 属性装饰器：注入配置值，**支持热更新** |
 *
 * ## 为什么用独立的登记表而不是复用 nea-boot 的 DecoratorRegistry
 *
 * nea-boot 的 `registerConfig` 语义是「读取指定 YAML 文件」，而 Nacos 配置
 * 是「按 dataId + group 远程拉取」，两者参数结构不同。
 * 复用会导致语义混淆，因此这里用独立登记表，由 `NacosAdapter` 读取。
 */

/** 配置项声明元数据 */
interface ConfigDecl {
    dataId: string;
    group?: string;
    type?: 'yaml' | 'yml' | 'json' | 'properties' | 'text';
    required?: boolean;
}

/** 服务声明元数据 */
interface ServiceDecl {
    name: string;
    groupName?: string;
    clusterName?: string;
    weight?: number;
    ephemeral?: boolean;
    ip?: string;
    port?: number;
    metadata?: Record<string, string>;
}

/** `@NacosValue` 热更新订阅者 */
interface ValueBinding {
    target: any;
    propertyKey: string;
    keyPath: string;
    defaultValue: string | null;
    valueType: 'string' | 'number' | 'boolean' | 'object';
}

/** 注解登记表（模块级单例） */
class NacosAnnotationRegistry {
    private configs: ConfigDecl[] = [];
    private services: ServiceDecl[] = [];
    private values: ValueBinding[] = [];
    private enableOptions: any = null;

    /** 登记一个配置项（同 dataId+group 去重） */
    addConfig(decl: ConfigDecl): void {
        const exists = this.configs.some(
            c => c.dataId === decl.dataId && (c.group || 'DEFAULT_GROUP') === (decl.group || 'DEFAULT_GROUP'),
        );
        if (exists) return;
        this.configs.push(decl);
    }

    /** 登记一个服务（同名去重） */
    addService(decl: ServiceDecl): void {
        const idx = this.services.findIndex(s => s.name === decl.name);
        if (idx >= 0) this.services[idx] = { ...this.services[idx], ...decl };
        else this.services.push(decl);
    }

    /** 登记一个 @NacosValue 绑定 */
    addValue(binding: ValueBinding): void {
        const exists = this.values.some(
            v => v.target === binding.target && v.propertyKey === binding.propertyKey,
        );
        if (exists) return;
        this.values.push(binding);
    }

    setEnableOptions(opts: any): void {
        this.enableOptions = opts;
    }

    getConfigs(): ConfigDecl[] {
        return [...this.configs];
    }

    getServices(): ServiceDecl[] {
        return [...this.services];
    }

    getValues(): ValueBinding[] {
        return [...this.values];
    }

    getEnableOptions(): any {
        return this.enableOptions;
    }

    /** 是否有任何注解被使用（决定是否需要自动启动） */
    hasAnything(): boolean {
        return this.configs.length > 0 || this.services.length > 0 || this.enableOptions !== null;
    }

    reset(): void {
        this.configs = [];
        this.services = [];
        this.values = [];
        this.enableOptions = null;
    }
}

/** 全局单例 */
export const annotationRegistry = new NacosAnnotationRegistry();

// ============================================================
// 装饰器实现
// ============================================================

/**
 * `@EnableNacos(options?)` —— 在应用入口类上声明 Nacos 连接参数。
 *
 * **注意装饰器执行顺序**：TypeScript 类装饰器**从下往上**执行，
 * 因此 `@EnableNacos` 必须写在 `@EnableApplication` **上方**，
 * 保证它在应用启动前完成登记：
 *
 * ```ts
 * @EnableNacos({ serverAddr: '127.0.0.1:8848' })
 * @EnableApplication({ port: 3000, scanPath: ['/src'] })
 * class App {}
 * ```
 *
 * ⚠️ 但即使顺序正确，`@EnableApplication` 也会**立即**触发启动（同步的），
 * 而 Nacos 配置拉取是异步的。因此**推荐用 `bootstrapWithNacos()` 代替**：
 *
 * ```ts
 * await bootstrapWithNacos({ port: 3000, scanPath: ['/src'] });
 * ```
 *
 * 装饰器方式适合「只要注册中心，不需要在启动前拉配置」的场景。
 */
export const EnableNacos = (options: {
    serverAddr?: string | string[];
    namespace?: string;
    username?: string;
    password?: string;
    timeout?: number;
    watch?: boolean;
    onConfigChange?: (config: Record<string, any>, changed: { dataId: string; content: string }) => void;
} = {}): ClassDecorator => {
    return (_constructor: any) => {
        annotationRegistry.setEnableOptions(options);
    };
};

/**
 * `@NacosConfig({ dataId, group? })` —— 声明一个要拉取的 Nacos 配置。
 *
 * 可标在任意类上，也支持标在 `@EnableNacos` 所在类上。
 * 声明顺序 = 合并顺序（后声明的覆盖先声明的）。
 *
 * ```ts
 * @NacosConfig({ dataId: 'application.yml' })
 * @NacosConfig({ dataId: 'application-dev.yml', group: 'DEV_GROUP' })
 * @Service()
 * class MyService {}
 * ```
 *
 * 注意：多个装饰器叠在同一类上时，**下面的先执行**，
 * 因此写在最下面的会**最先**被登记（先合并、优先级最低）。
 */
export const NacosConfig = (decl: NacosConfigItem): ClassDecorator => {
    return (_constructor: any) => {
        if (!decl?.dataId) {
            logError('[nacos] @NacosConfig 缺少 dataId，已忽略');
            return;
        }
        annotationRegistry.addConfig({
            dataId: decl.dataId,
            group: decl.group,
            type: decl.type,
            required: decl.required,
        });
        log(`[nacos] @NacosConfig 登记: ${decl.dataId}（group=${decl.group || 'DEFAULT_GROUP'}）`);
    };
};

/**
 * `@NacosService({ name, group? })` —— 声明把当前服务注册到 Nacos。
 *
 * ```ts
 * @NacosService({ name: 'user-service', groupName: 'DEV_GROUP' })
 * @Service()
 * class App {}
 * ```
 *
 * 也可以只传服务名：`@NacosService('user-service')`。
 */
export const NacosService = (
    decl: string | ServiceDecl,
): ClassDecorator => {
    return (_constructor: any) => {
        const d: ServiceDecl = typeof decl === 'string' ? { name: decl } : decl;
        if (!d?.name) {
            logError('[nacos] @NacosService 缺少 name，已忽略');
            return;
        }
        annotationRegistry.addService(d);
        log(`[nacos] @NacosService 登记: ${d.name}`);
    };
};

/**
 * `@NacosValue('key.path')` —— 属性装饰器，注入 Nacos 配置值，**支持热更新**。
 *
 * 与 nea-boot 的 `@Value` 的区别：
 *
 * | | `@Value` | `@NacosValue` |
 * |---|---|---|
 * | 注入时机 | 启动时一次性 | 启动时 + **每次配置变更** |
 * | 热更新 | ❌ 不会更新 | ✅ 自动重新赋值 |
 * | 数据来源 | `ConfigManager.config` | 同一份（Nacos 合并后的）|
 *
 * 语法与 `@Value` 完全一致：`'service.port:8080'` 表示「读 service.port，缺省 8080」。
 *
 * ```ts
 * @Service()
 * class MyService {
 *   @NacosValue('app.greeting:hello')
 *   private greeting: string;
 *
 *   @NacosValue('feature.enabled:false', 'boolean')
 *   private enabled: boolean;
 * }
 * ```
 *
 * ⚠️ 热更新生效的前提是开启了 `watch: true`（默认开启）。
 */
export const NacosValue = (
    property: string,
    valueType: 'string' | 'number' | 'boolean' | 'object' = 'string',
): PropertyDecorator => {
    return (target: any, propertyKey?: any) => {
        // 兼容 TC39 装饰器（第二参是 { kind, name }）
        let realTarget = target;
        let realKey: string;

        if (propertyKey && typeof propertyKey === 'object' && propertyKey.kind) {
            // TC39: target 是 value，context 是第二参
            const ctx = propertyKey;
            realKey = typeof ctx.name === 'symbol' ? ctx.name.toString() : ctx.name;
            // TC39 下无法拿到 prototype，退化为「不做热更新」
            // 记录到一个特殊容器，由 setAccessor 机制处理
            if (ctx.addInitializer) {
                const parsed = parsePropertyString(property);
                ctx.addInitializer(function (this: any) {
                    annotationRegistry.addValue({
                        target: this,
                        propertyKey: realKey,
                        keyPath: parsed.keyPath,
                        defaultValue: parsed.defaultValue,
                        valueType,
                    });
                });
            }
            return;
        }

        realKey = typeof propertyKey === 'symbol' ? propertyKey.toString() : String(propertyKey);
        const parsed = parsePropertyString(property);

        annotationRegistry.addValue({
            target,
            propertyKey: realKey,
            keyPath: parsed.keyPath,
            defaultValue: parsed.defaultValue,
            valueType,
        });
    };
};

/** 解析 `key.path:defaultValue`（只按第一个冒号切分） */
function parsePropertyString(property: string): { keyPath: string; defaultValue: string | null } {
    const idx = property.indexOf(':');
    if (idx < 0) return { keyPath: property, defaultValue: null };
    return { keyPath: property.slice(0, idx), defaultValue: property.slice(idx + 1) };
}

// ============================================================
// 由 NacosAdapter 调用的内部函数
// ============================================================

/**
 * 把所有 `@NacosValue` 绑定应用到组件实例上。
 *
 * @param instances 已实例化的对象列表（通常是 componentManager 里的所有实例）
 * @param config 合并后的配置对象
 */
export function applyNacosValues(instances: any[], config: Record<string, any>): number {
    const bindings = annotationRegistry.getValues();
    if (bindings.length === 0) return 0;

    let applied = 0;
    for (const b of bindings) {
        // 找到匹配的实例：target 可能是 prototype，也可能是实例本身
        const instance = instances.find(i => {
            if (i === b.target) return true;
            const proto = Object.getPrototypeOf(i);
            return proto === b.target;
        });
        if (!instance) continue;

        try {
            const v = resolveValue(config, b.keyPath, b.defaultValue, b.valueType);
            if (v.present) {
                instance[b.propertyKey] = v.value;
                applied++;
            }
        } catch (e) {
            logError(`[nacos] @NacosValue 注入失败 ${b.propertyKey}:`, e);
        }
    }
    return applied;
}

/**
 * 配置变更时刷新所有 `@NacosValue` 字段（热更新）。
 *
 * @returns 刷新成功的字段数
 */
export function refreshNacosValues(instances: any[], config: Record<string, any>): number {
    const bindings = annotationRegistry.getValues();
    if (bindings.length === 0) return 0;

    let refreshed = 0;
    for (const b of bindings) {
        const instance = instances.find(i => {
            if (i === b.target) return true;
            const proto = Object.getPrototypeOf(i);
            return proto === b.target;
        });
        if (!instance) continue;

        try {
            const v = resolveValue(config, b.keyPath, b.defaultValue, b.valueType);
            if (v.present) {
                const old = instance[b.propertyKey];
                instance[b.propertyKey] = v.value;
                if (old !== v.value) {
                    log(`[nacos] 热更新 ${b.propertyKey}: ${JSON.stringify(old)} -> ${JSON.stringify(v.value)}`);
                }
                refreshed++;
            }
        } catch (e) {
            logError(`[nacos] 热更新失败 ${b.propertyKey}:`, e);
        }
    }
    return refreshed;
}

/** 按路径解析配置值（含默认值兜底与类型转换） */
function resolveValue(
    config: Record<string, any>,
    keyPath: string,
    defaultValue: string | null,
    valueType: string,
): { present: boolean; value?: unknown } {
    let raw = getByPath(config, keyPath);
    if (raw === undefined && defaultValue !== null) raw = defaultValue;
    if (raw === undefined) return { present: false };

    switch (valueType) {
        case 'number': {
            const n = Number(raw);
            if (!Number.isFinite(n)) throw new TypeError(`无法转换为 number`);
            return { present: true, value: n };
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return { present: true, value: raw };
            if (typeof raw === 'number') return { present: true, value: raw !== 0 };
            const s = String(raw).trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(s)) return { present: true, value: true };
            if (['false', '0', 'no', 'off', ''].includes(s)) return { present: true, value: false };
            throw new TypeError(`无法转换为 boolean`);
        }
        case 'object':
            return { present: true, value: raw };
        case 'string':
        default:
            return { present: true, value: typeof raw === 'string' ? raw : String(raw) };
    }
}

/** 按 `a.b.c` 取值 */
function getByPath(obj: any, keyPath: string): unknown {
    if (!keyPath) return undefined;
    let cur: any = obj;
    for (const seg of keyPath.split('.')) {
        if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined;
        if (cur === null || cur === undefined) return undefined;
        if (typeof cur !== 'object' && typeof cur !== 'function') return undefined;
        cur = cur[seg];
    }
    return cur;
}
