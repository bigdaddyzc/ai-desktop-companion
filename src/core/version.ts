// Node 原生 ESM（Playwright 会直接加载）要求 JSON 带 type 属性且只能默认导入。
import metadata from '../../package.json' with { type: 'json' };

/** Single version source for the renderer and host handshake. */
export const appVersion = metadata.version;
