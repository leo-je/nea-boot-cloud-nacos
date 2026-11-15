/**
 * nea-boot-cloud-nacos —— Nacos 配置中心 / 注册中心适配层类型定义
 */

/** 一个 Nacos 配置项声明 */
export interface NacosConfigItem {
    /** 数据 ID，如 `application.yml` */
    dataId: string;
    /** 分组，默认 `DEFAULT_GROUP` */
    group?: string;
    /**
     * 配置格式。决定如何解析配置内容：
     * - `yaml` / `yml`：按 YAML 解析成对象后深合并进配置
     * - `json`：按 JSON 解析
     * - `properties`：按 `key=value` 逐行解析，key 用 `.` 表示层级
     * - `text`：原样字符串，挂在 `nacos.raw[dataId]` 下
     */
    type?: 'yaml' | 'yml' | 'json' | 'properties' | 'text';
    /**
     * 是否必需。为 true 时，若拉取失败或配置为空，启动会失败。
     * 默认 false（失败时告警并继续）。
     */
    required?: boolean;
}

/** Nacos 客户端连接与适配选项 */
export interface NacosOptions {
    /** Nacos 服务地址，如 `127.0.0.1:8848`，或地址数组 */
    serverAddr?: string | string[];
    /** 命名空间 ID（非名称），默认 `public` 对应空字符串 */
    namespace?: string;
    /** 用户名（开启鉴权时必需） */
    username?: string;
    /** 密码 */
    password?: string;
    /** 请求超时（毫秒），默认 5000 */
    timeout?: number;

    /** 要拉取的配置列表 */
    configs?: NacosConfigItem[];
    /**
     * 是否监听配置变更（长轮询）。默认 true。
     * 变更后会重新合并进 `ConfigManager.config` 并触发 `onConfigChange`。
     */
    watch?: boolean;

    /** 注册中心：服务名（不传则不注册） */
    serviceName?: string;
    /** 注册中心的 IP，默认自动探测本机 IP */
    ip?: string;
    /** 注册中心的端口，默认取 `Application.yml` 的 `service.port` */
    port?: number;
    /** 集群名，默认 `DEFAULT` */
    clusterName?: string;
    /** 实例权重，默认 1 */
    weight?: number;
    /** 是否为临时实例（临时实例靠心跳，宕机自动摘除）。默认 true */
    ephemeral?: boolean;
    /** 分组名，默认 `DEFAULT_GROUP` */
    groupName?: string;
    /** 实例元数据 */
    metadata?: Record<string, string>;

    /**
     * 配置变更回调。参数为变更后的完整配置对象。
     * 注意：只影响 `ConfigManager.config`，已注入组件的 `@Value` 字段**不会**自动更新。
     */
    onConfigChange?: (config: Record<string, any>, changed: { dataId: string; content: string }) => void;

    /** 自定义日志方法，默认走 nea-boot 的 log */
    logger?: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string, e?: unknown) => void;
    };
}

/** 适配器运行状态 */
export interface NacosStatus {
    /** 配置是否已成功拉取 */
    configLoaded: boolean;
    /** 已成功拉取的 dataId 列表 */
    loadedDataIds: string[];
    /** 是否已注册到注册中心 */
    registered: boolean;
    /** 注册的实例信息 */
    instance: { ip: string; port: number; serviceName: string } | null;
    /** 最近一次错误 */
    lastError: string | null;
}
