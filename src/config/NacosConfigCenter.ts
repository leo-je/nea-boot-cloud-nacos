import { NacosConfigClient } from 'nacos';
import { log, error as logError } from 'nea-boot';
import { NacosConfigItem, NacosOptions } from '../types';
import { parseContent } from './parser';

/** 默认分组 */
const DEFAULT_GROUP = 'DEFAULT_GROUP';

/** 一条已拉取的配置 */
export interface LoadedConfig {
    dataId: string;
    group: string;
    type: string;
    /** 解析后的对象（type=text 时为空对象） */
    parsed: Record<string, any>;
    /** 原始文本（type=text 时用） */
    raw: string;
}

/**
 * Nacos 配置中心适配
 *
 * 负责：
 * 1. 启动时拉取声明的配置项并按类型解析
 * 2. 按顺序深合并（后声明的覆盖先声明的）
 * 3. 可选的长轮询监听，配置变更时回调
 *
 * ## 合并语义
 *
 * 多个配置项**按数组顺序**依次合并，后面的覆盖前面的。因此推荐写法：
 *
 * ```ts
 * configs: [
 *   { dataId: 'application.yml' },              // 基础配置
 *   { dataId: `application-${profile}.yml` },   // 环境覆盖
 * ]
 * ```
 */
export class NacosConfigCenter {
    private client: NacosConfigClient | null = null;
    private options: NacosOptions;
    private loaded: Map<string, LoadedConfig> = new Map();
    private subscribers: Map<string, (content: string) => void> = new Map();

    constructor(options: NacosOptions) {
        this.options = options;
    }

    private get logPrefix(): string {
        return '[nacos-config]';
    }

    /** 建立客户端连接 */
    private ensureClient(): NacosConfigClient {
        if (this.client) return this.client;

        const o = this.options;
        const opts: any = {
            serverAddr: Array.isArray(o.serverAddr) ? o.serverAddr.join(',') : (o.serverAddr || '127.0.0.1:8848'),
            namespace: o.namespace || '',
            requestTimeout: o.timeout ?? 5000,
        };
        if (o.username) {
            // 开启鉴权的 Nacos 需要 username/password
            opts.username = o.username;
            opts.password = o.password || '';
        }

        this.client = new NacosConfigClient(opts);
        return this.client;
    }

    /**
     * 拉取所有声明的配置并返回合并结果。
     *
     * 单个配置失败时：
     * - `required: true` → 抛错，中断启动
     * - 否则 → 记录错误日志并继续（符合“配置中心短暂不可用不应阻断启动”的实践）
     */
    async load(): Promise<Record<string, any>> {
        const items = this.options.configs || [];
        if (items.length === 0) return {};

        const client = this.ensureClient();
        let merged: Record<string, any> = {};

        for (const item of items) {
            const group = item.group || DEFAULT_GROUP;
            const type = item.type || inferType(item.dataId);
            const key = `${group}@@${item.dataId}`;

            try {
                const content = await client.getConfig(item.dataId, group);
                const raw = content ?? '';

                if (!raw.trim()) {
                    if (item.required) {
                        throw new Error(`配置为空或不存在（required=true）`);
                    }
                    log(`${this.logPrefix} ${item.dataId}（group=${group}）为空，跳过`);
                    continue;
                }

                const parsed = parseContent(raw, type, item.dataId);
                const loadedItem: LoadedConfig = { dataId: item.dataId, group, type, parsed, raw };
                this.loaded.set(key, loadedItem);

                // 按顺序合并，后面的覆盖前面的
                if (type === 'text') {
                    merged.nacos = merged.nacos || {};
                    merged.nacos.raw = merged.nacos.raw || {};
                    merged.nacos.raw[item.dataId] = raw;
                } else {
                    merged = deepMergeNacos(merged, parsed) as Record<string, any>;
                }

                log(
                    `${this.logPrefix} 已拉取 ${item.dataId}（group=${group}, type=${type}, ` +
                    `${raw.length} 字节）`,
                );
            } catch (e) {
                const msg = `拉取配置失败 ${item.dataId}（group=${group}）: ${(e as Error).message}`;
                if (item.required) {
                    throw new Error(msg);
                }
                logError(`${this.logPrefix} ${msg}（非必需，继续启动）`);
            }
        }

        if (this.options.watch) {
            this.startWatch();
        }

        return merged;
    }

    /**
     * 监听配置变更。
     *
     * Nacos 的长轮询在客户端内部实现，这里只注册回调：
     * 收到变更后重新解析、重新合并全量配置，然后通知上层。
     */
    private startWatch(): void {
        const client = this.client;
        if (!client) return;

        for (const [key, item] of this.loaded) {
            const handler = async (content: string) => {
                try {
                    const parsed = parseContent(content, item.type as any, item.dataId);
                    const newItem: LoadedConfig = {
                        dataId: item.dataId,
                        group: item.group,
                        type: item.type,
                        parsed,
                        raw: content,
                    };
                    this.loaded.set(key, newItem);
                    log(`${this.logPrefix} 配置已变更: ${item.dataId}`);

                    // 重新合并全量
                    const merged = this.mergeAll();
                    this.options.onConfigChange?.(merged, {
                        dataId: item.dataId,
                        content,
                    });
                } catch (e) {
                    logError(`${this.logPrefix} 处理配置变更失败 ${item.dataId}:`, e);
                }
            };

            this.subscribers.set(key, handler as any);
            try {
                client.subscribe({ dataId: item.dataId, group: item.group }, handler as any);
                log(`${this.logPrefix} 已监听 ${item.dataId}`);
            } catch (e) {
                logError(`${this.logPrefix} 订阅失败 ${item.dataId}:`, e);
            }
        }
    }

    /** 把所有已加载的配置重新合并一遍（配置变更时用） */
    private mergeAll(): Record<string, any> {
        let merged: Record<string, any> = {};
        for (const item of this.loaded.values()) {
            if (item.type === 'text') {
                merged.nacos = merged.nacos || {};
                merged.nacos.raw = merged.nacos.raw || {};
                merged.nacos.raw[item.dataId] = item.raw;
            } else {
                merged = deepMergeNacos(merged, item.parsed) as Record<string, any>;
            }
        }
        return merged;
    }

    /** 已成功加载的 dataId 列表 */
    getLoadedDataIds(): string[] {
        return [...this.loaded.values()].map(i => i.dataId);
    }

    /** 关闭客户端（取消订阅 + 释放连接） */
    async close(): Promise<void> {
        if (!this.client) return;
        try {
            this.client.close();
        } catch {
            /* 关闭失败不阻塞 */
        }
        this.client = null;
        this.subscribers.clear();
    }
}

/**
 * 深合并 Nacos 配置。
 *
 * 与 nea-boot 的 `deepMerge` 语义保持一致：
 * - 普通对象递归合并
 * - 数组与标量直接覆盖
 * - 跳过 null/undefined
 */
export function deepMergeNacos<T>(target: T, source: any): T {
    if (source === null || source === undefined) return target;
    if (typeof source !== 'object' || Array.isArray(source)) return source as T;
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return source as T;

    const out: any = { ...(target as any) };
    for (const key of Object.keys(source)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const sv = source[key];
        const tv = out[key];
        if (
            sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
            tv !== null && typeof tv === 'object' && !Array.isArray(tv)
        ) {
            out[key] = deepMergeNacos(tv, sv);
        } else if (sv !== null && sv !== undefined) {
            out[key] = sv;
        }
    }
    return out;
}

/** 从 dataId 推断配置格式 */
export function inferType(dataId: string): 'yaml' | 'yml' | 'json' | 'properties' | 'text' {
    const lower = dataId.toLowerCase();
    if (lower.endsWith('.yml')) return 'yml';
    if (lower.endsWith('.yaml')) return 'yaml';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.properties')) return 'properties';
    return 'text';
}

/** 供外部判断某 dataId 是否已加载 */
export function isConfigItem(item: NacosConfigItem): boolean {
    return !!item.dataId;
}