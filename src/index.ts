/**
 * nea-boot-cloud-nacos
 *
 * Nacos 配置中心与注册中心适配，用于 nea-boot 框架。
 *
 * @example
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
 * await nacos.start({ port: 3000, scanPath: ['/src'] });
 * ```
 */

// ---------------------------------------------------------------- 适配器
export { NacosAdapter } from './NacosAdapter';

// ------------------------------------------------------ 注解（装饰器）方式
export {
    EnableNacos,
    NacosConfig,
    NacosService,
    NacosValue,
    annotationRegistry,
    applyNacosValues,
    refreshNacosValues,
} from './annotations';

// 注解统一启动入口
export { bootstrapWithNacos } from './bootstrap';

// ------------------------------------------------------------ 配置中心
export {
    NacosConfigCenter,
    deepMergeNacos,
    inferType,
} from './config/NacosConfigCenter';
export type { LoadedConfig } from './config/NacosConfigCenter';

// ------------------------------------------------------ 配置解析（可单测）
export {
    parseContent,
    parseProperties,
    sanitizeObject,
    isUnsafeKey,
} from './config/parser';

// ------------------------------------------------------------ 注册中心
export { NacosRegistry, detectLocalIp } from './registry/NacosRegistry';
export type { RegisteredInstance } from './registry/NacosRegistry';

// ---------------------------------------------------------------- 类型
export type {
    NacosOptions,
    NacosConfigItem,
    NacosStatus,
} from './types';
