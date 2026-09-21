/**
 * 访客身份：原型用本地生成的稳定 userId（服务端仅按头信息识别，配合限流）。
 * 生产环境应替换为登录态/Session。
 */

export interface Identity {
  id: string;
  name: string;
}

const KEY = 'microbe-gallery-identity';

function randomId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (parsed.id && typeof parsed.name === 'string') {
        return { id: parsed.id, name: parsed.name };
      }
    }
  } catch {
    /* ignore */
  }
  const fresh: Identity = { id: randomId(), name: `访客${Math.floor(Math.random() * 9000 + 1000)}` };
  localStorage.setItem(KEY, JSON.stringify(fresh));
  return fresh;
}

export function setIdentityName(name: string): Identity {
  const cur = getIdentity();
  const next = { ...cur, name: name.slice(0, 24) || cur.name };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
