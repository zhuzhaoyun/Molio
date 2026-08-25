// apps/cloud/src/market/signer.ts
// 阿里云 OSS V1 签名（node:crypto 零依赖）。与 wxpay-fc/upload-resource.mjs 同一算法。
// 两种形态：预签名 URL（客户端直传/直下）+ 服务端带 Auth 头请求（HEAD/Copy/Delete）。
// ⚠️ AK/SK 只在本进程（FC 环境变量注入）；签名 URL 仅对单对象、单方法、限时有效。
import { createHmac } from 'node:crypto';

export interface OssOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** 测试覆盖（本地 mock 端点）；生产留空走 {bucket}.oss-{region}.aliyuncs.com */
  endpointOverride?: string;
}

export interface SignedTarget {
  key: string;
  url: string;
  contentType: string;
  expiresAt: number; // epoch 毫秒
}

export interface SignerHooks {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export class OssSigner {
  private now: () => number;
  private fetchImpl: typeof fetch;

  constructor(private opt: OssOptions, hooks: SignerHooks = {}) {
    this.now = hooks.now ?? Date.now;
    this.fetchImpl = hooks.fetchImpl ?? fetch;
  }

  baseUrl(): string {
    if (this.opt.endpointOverride) return this.opt.endpointOverride.replace(/\/+$/, '');
    return `https://${this.opt.bucket}.oss-${this.opt.region}.aliyuncs.com`;
  }

  /** URL 路径按段编码对象 key（保留 / 分隔符；与 wxpay-fc/upload-resource.mjs 一致） */
  private encPath(key: string): string {
    return key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  }

  /** 预签名 PUT（客户端直传）。contentType 锁进签名，客户端必须原样携带。 */
  signPut(key: string, contentType: string, ttlSec: number): SignedTarget {
    const expires = Math.floor(this.now() / 1000) + ttlSec;
    const sts = `PUT\n\n${contentType}\n${expires}\n/${this.opt.bucket}/${key}`;
    const sig = createHmac('sha1', this.opt.accessKeySecret).update(sts).digest('base64');
    const url = `${this.baseUrl()}/${this.encPath(key)}?OSSAccessKeyId=${encodeURIComponent(this.opt.accessKeyId)}`
      + `&Expires=${expires}&Signature=${encodeURIComponent(sig)}`;
    return { key, url, contentType, expiresAt: expires * 1000 };
  }

  /** 预签名 GET（限时下载）。contentDisposition 子资源同时进签名与 URL。 */
  signGet(key: string, ttlSec: number, contentDisposition?: string): SignedTarget {
    const expires = Math.floor(this.now() / 1000) + ttlSec;
    let canonical = `/${this.opt.bucket}/${key}`;
    let query = '';
    if (contentDisposition) {
      canonical += `?response-content-disposition=${contentDisposition}`;
      query = `?response-content-disposition=${encodeURIComponent(contentDisposition)}`;
    }
    const sts = `GET\n\n\n${expires}\n${canonical}`;
    const sig = createHmac('sha1', this.opt.accessKeySecret).update(sts).digest('base64');
    const url = `${this.baseUrl()}/${this.encPath(key)}${query}`
      + `${query ? '&' : '?'}OSSAccessKeyId=${encodeURIComponent(this.opt.accessKeyId)}`
      + `&Expires=${expires}&Signature=${encodeURIComponent(sig)}`;
    return { key, url, contentType: 'application/octet-stream', expiresAt: expires * 1000 };
  }

  /** 服务端鉴权头（Date 式）；ossHeaders 为 x-oss-* 头（排序后进 CanonicalizedHeaders） */
  private authHeaders(method: string, key: string, contentType: string, date: string, ossHeaders: Record<string, string>): Record<string, string> {
    const canonicalHeaders = Object.keys(ossHeaders)
      .sort()
      .map((k) => `${k.toLowerCase()}:${ossHeaders[k]}`)
      .join('\n');
    const sts = `${method}\n\n${contentType}\n${date}\n${canonicalHeaders ? canonicalHeaders + '\n' : ''}/${this.opt.bucket}/${key}`;
    const sig = createHmac('sha1', this.opt.accessKeySecret).update(sts).digest('base64');
    return {
      Authorization: `OSS ${this.opt.accessKeyId}:${sig}`,
      'Content-Type': contentType,
      Date: date,
      ...ossHeaders,
    };
  }

  /** HEAD 对象：不存在/403 → null（桶私有，不泄漏存在性） */
  async headObject(key: string): Promise<{ size: number } | null> {
    const date = new Date(this.now()).toUTCString();
    const res = await this.fetchImpl(`${this.baseUrl()}/${this.encPath(key)}`, {
      method: 'HEAD',
      headers: this.authHeaders('HEAD', key, '', date, {}),
    });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`oss HEAD failed: ${res.status}`);
    return { size: Number(res.headers.get('content-length') ?? '0') };
  }

  /** 服务端复制（暂存→转正）；objectAcl 置目标 ACL */
  async copyObject(srcKey: string, destKey: string, objectAcl?: 'private' | 'public-read'): Promise<void> {
    const date = new Date(this.now()).toUTCString();
    const ossHeaders: Record<string, string> = { 'x-oss-copy-source': `/${this.opt.bucket}/${srcKey}` };
    if (objectAcl) ossHeaders['x-oss-object-acl'] = objectAcl;
    const res = await this.fetchImpl(`${this.baseUrl()}/${this.encPath(destKey)}`, {
      method: 'PUT',
      headers: this.authHeaders('PUT', destKey, '', date, ossHeaders),
    });
    if (!res.ok) throw new Error(`oss COPY failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  /** 删除对象（尽力而为，调用方自行捕获降级） */
  async deleteObject(key: string): Promise<void> {
    const date = new Date(this.now()).toUTCString();
    const res = await this.fetchImpl(`${this.baseUrl()}/${this.encPath(key)}`, {
      method: 'DELETE',
      headers: this.authHeaders('DELETE', key, '', date, {}),
    });
    if (!res.ok && res.status !== 404) throw new Error(`oss DELETE failed: ${res.status}`);
  }
}