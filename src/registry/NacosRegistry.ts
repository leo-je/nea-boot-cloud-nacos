import os from 'node:os';
import { NacosNamingClient } from 'nacos';
import { log, error as logError } from 'nea-boot';
import { NacosOptions } from '../types';

/** 默认分组 */
const DEFAULT_GROUP = 'DEFAULT_GROUP';

/** 注册到 Nacos 的实例信息 */
export interface RegisteredInstance {
    serviceName: string;
    ip: string;
    port: number;
    groupName: string;
    clusterName: string;
    weight: number;
    ephemeral: boolean;
    metadata: Record<string, string>;
}

/**
 * Nacos 注册中心适配
 *
 * 负责：
 * 1. 启动后把当前服务实例注册到 Nacos
 * 2. 关闭时注销（避免僵尸实例）
 *
 * ## 为什么必须在 listen 之后注册
 *
 * 注册的那一刻，Nacos 就会开始把流量路由过来。若端口尚未监听，
 * 会导致请求失败。因此这个类由框架在 `listen()` 成功后调用。
 */
export class NacosRegistry {
    private client: NacosNamingClient | null = null;
    private options: NacosOptions;
    private instance: RegisteredInstance | null = null;
    private registered = false;

    constructor(options: NacosOptions) {
        this.options = options;
    }

    private get logPrefix(): string {
        return '[nacos-registry]';
    }

    /** 建立客户端连接 */
    private ensureClient(): NacosNamingClient {
        if (this.client) return this.client;

        const o = this.options;
        const opts: any = {
            serverAddr: Array.isArray(o.serverAddr) ? o.serverAddr.join(',') : (o.serverAddr || '127.0.0.1:8848'),
            namespace: o.namespace || '',
            requestTimeout: o.timeout ?? 5000,
        };
        if (o.username) {
            opts.username = o.username;
            opts.password = o.password || '';
        }

        this.client = new NacosNamingClient(opts);
        return this.client;
    }

    /**
     * 注册实例。
     *
     * @param fallbackPort 未显式配置 port 时使用的端口（通常传实际监听的端口）
     * @throws 注册失败时抛错，由调用方决定是否致命
     */
    async register(fallbackPort: number): Promise<RegisteredInstance | null> {
        const o = this.options;
        if (!o.serviceName) {
            log(`${this.logPrefix} 未配置 serviceName，跳过注册`);
            return null;
        }

        if (this.registered && this.instance) {
            log(`${this.logPrefix} 已注册，跳过重复注册`);
            return this.instance;
        }

        const ip = o.ip || detectLocalIp();
        const port = o.port ?? fallbackPort;

        if (!Number.isFinite(port) || port <= 0) {
            throw new Error(`注册服务的端口非法: ${port}`);
        }

        const instance: RegisteredInstance = {
            serviceName: o.serviceName,
            ip,
            port,
            groupName: o.groupName || DEFAULT_GROUP,
            clusterName: o.clusterName || 'DEFAULT',
            weight: o.weight ?? 1,
            ephemeral: o.ephemeral ?? true,
            metadata: o.metadata || {},
        };

        const client = this.ensureClient();
        await client.registerInstance(instance.serviceName, {
            ip: instance.ip,
            port: instance.port,
            weight: instance.weight,
            ephemeral: instance.ephemeral,
            clusterName: instance.clusterName,
            metadata: instance.metadata,
            serviceName: instance.serviceName,
        } as any, instance.groupName);

        this.instance = instance;
        this.registered = true;
        log(
            `${this.logPrefix} 已注册 ${instance.serviceName} -> ${instance.ip}:${instance.port} ` +
            `(group=${instance.groupName}, cluster=${instance.clusterName}, ephemeral=${instance.ephemeral})`,
        );
        return instance;
    }

    /**
     * 注销实例。
     *
     * 必须幂等：框架的 shutdown 可能被重复触发。
     */
    async deregister(): Promise<void> {
        if (!this.registered || !this.instance || !this.client) return;

        try {
            await this.client.deregisterInstance(
                this.instance.serviceName,
                {
                    ip: this.instance.ip,
                    port: this.instance.port,
                    clusterName: this.instance.clusterName,
                    serviceName: this.instance.serviceName,
                } as any,
                this.instance.groupName,
            );
            log(`${this.logPrefix} 已注销 ${this.instance.serviceName}`);
        } catch (e) {
            // 注销失败不应阻塞关闭流程，但必须记录（可能留下僵尸实例）
            logError(`${this.logPrefix} 注销失败（可能留下僵尸实例）:`, e);
        } finally {
            this.registered = false;
        }
    }

    /** 当前注册的实例信息 */
    getInstance(): RegisteredInstance | null {
        return this.instance;
    }

    /** 是否已注册 */
    isRegistered(): boolean {
        return this.registered;
    }

    /**
     * 查询某个服务的健康实例（供服务发现使用）
     */
    async getHealthyInstances(serviceName: string, groupName = DEFAULT_GROUP): Promise<Array<{ ip: string; port: number; metadata: any }>> {
        const client = this.ensureClient();
        const hosts: any[] = await client.getAllInstances(serviceName, groupName) as any;
        return (hosts || [])
            .filter((h: any) => h.healthy !== false && h.enabled !== false)
            .map((h: any) => ({ ip: h.ip, port: h.port, metadata: h.metadata || {} }));
    }

    /** 关闭客户端 */
    async close(): Promise<void> {
        await this.deregister();
        if (this.client) {
            try {
                (this.client as any).close?.();
            } catch {
                /* 忽略 */
            }
            this.client = null;
        }
    }
}

/**
 * 探测本机可用的内网 IP。
 *
 * 优先返回非回环、非虚拟网卡的 IPv4。若都找不到则退回 127.0.0.1
 * （仅适用于单机调试，生产必须显式配置 `nacos.ip`）。
 */
export function detectLocalIp(): string {
    const nets = os.networkInterfaces();
    const candidates: string[] = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net.family !== 'IPv4' || net.internal) continue;
            // 跳过常见虚拟网卡（docker / vmware / utun 等）
            if (/^(docker|veth|br-|vmnet|vboxnet|utun|tun|tap)/i.test(name)) continue;
            candidates.push(net.address);
        }
    }

    // 优先 192.168 / 10. / 172.16-31
    const preferred = candidates.find(ip =>
        ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip),
    );
    return preferred || candidates[0] || '127.0.0.1';
}