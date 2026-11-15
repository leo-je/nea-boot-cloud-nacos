import yaml from 'js-yaml';

/**
 * 配置内容解析器
 *
 * Nacos 上的配置是纯文本，需要按 `type` 解析成对象才能合并进
 * nea-boot 的 `ConfigManager.config`。
 */

/**
 * 解析 `properties` 格式。
 *
 * ```
 * service.port=8080
 * service.name=my-app
 * # 注释
 * ```
 * 会解析成 `{ service: { port: '8080', name: 'my-app' } }`。
 *
 * 实现要点：
 * - `#` 或 `!` 开头为注释
 * - 只按**第一个** `=` 或 `:` 切分（值里可能含 `=`）
 * - key 里的 `.` 展开为嵌套对象
 * - 值保持字符串（与 Spring 行为一致），需要数字/布尔时由 `@Value(..., 'number')` 转换
 */
export function parseProperties(content: string): Record<string, any> {
    const out: Record<string, any> = {};

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#') || line.startsWith('!')) continue;

        // 找第一个未被转义的 = 或 :
        let sepIdx = -1;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '\\') { i++; continue; }
            if (ch === '=' || ch === ':') { sepIdx = i; break; }
        }
        if (sepIdx <= 0) continue;

        const key = line.slice(0, sepIdx).trim();
        const value = line.slice(sepIdx + 1).trim();
        if (!key) continue;

        setByPath(out, key, value);
    }

    return out;
}

/** 按 `a.b.c` 路径写值，自动创建中间对象 */
function setByPath(target: Record<string, any>, keyPath: string, value: any): void {
    const segments = keyPath.split('.').filter(s => s !== '');
    if (segments.length === 0) return;

    let cur: any = target;
    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        // 防原型污染：不允许覆盖 __proto__ / constructor / prototype
        if (isUnsafeKey(seg)) return;
        if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== 'object') {
            cur[seg] = {};
        }
        cur = cur[seg];
    }
    const last = segments[segments.length - 1];
    if (isUnsafeKey(last)) return;
    cur[last] = value;
}

/** 原型污染防护：这些键不允许出现在配置路径里 */
export function isUnsafeKey(key: string): boolean {
    return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * 按类型解析配置内容。
 *
 * @param content Nacos 返回的原始文本
 * @param type 声明的格式
 * @param dataId 仅用于错误提示
 * @throws Error 解析失败时（由调用方决定是否致命）
 */
export function parseContent(
    content: string,
    type: 'yaml' | 'yml' | 'json' | 'properties' | 'text' = 'yaml',
    dataId = '',
): Record<string, any> {
    const text = content ?? '';

    switch (type) {
        case 'text':
            // 原样字符串，交给调用方挂在 nacos.raw 下
            return { __raw: text };

        case 'json': {
            if (!text.trim()) return {};
            const data = JSON.parse(text);
            if (data === null || typeof data !== 'object' || Array.isArray(data)) {
                throw new TypeError(
                    `Nacos 配置 ${dataId} 声明为 json，但顶层不是对象（实际是 ${Array.isArray(data) ? 'array' : typeof data}）`,
                );
            }
            return sanitizeObject(data);
        }

        case 'properties': {
            if (!text.trim()) return {};
            return parseProperties(text);
        }

        case 'yaml':
        case 'yml':
        default: {
            if (!text.trim()) return {};
            const data = yaml.load(text);
            if (data === null || data === undefined) return {};
            if (typeof data !== 'object' || Array.isArray(data)) {
                throw new TypeError(
                    `Nacos 配置 ${dataId} 声明为 ${type}，但顶层不是对象（实际是 ${Array.isArray(data) ? 'array' : typeof data}）`,
                );
            }
            return sanitizeObject(data as Record<string, any>);
        }
    }
}

/**
 * 递归剔除危险键，防止 Nacos 上的恶意/错误配置污染原型链。
 *
 * 虽然 yaml.load / JSON.parse 本身不会触发 setter，但后续 deepMerge
 * 赋值时若遇到 `__proto__` 这类键仍可能出问题，所以在入口处就清掉。
 */
export function sanitizeObject(obj: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
        if (isUnsafeKey(key)) continue;
        const v = obj[key];
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            out[key] = sanitizeObject(v as Record<string, any>);
        } else {
            out[key] = v;
        }
    }
    return out;
}
