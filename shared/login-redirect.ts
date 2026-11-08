/** Accept local public/admin return URLs without login loops or URL confusion. */
export function normalizeLoginRedirect(value: unknown, origin: string): string | null {
  if(typeof value!=="string" || !value || value.length>2000 || /[\\\u0000-\u0020\u007f]/.test(value) || value.startsWith("//"))return null;
  if(!value.startsWith("/") && !/^https?:\/\//i.test(value))return null;
  try {
    const url=new URL(value,origin);
    if(url.origin!==origin || !["http:","https:"].includes(url.protocol) || url.username || url.password)return null;
    let path=url.pathname;
    for(let i=0;i<5;i++){
      if(!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path))return null;
      if(/^\/(?:login|logout|public-login|api\/auth)(?:\/|$)/i.test(path) || /^\/wp-login\.php(?:\/|$)/i.test(path))return null;
      const decoded=decodeURIComponent(path);
      if(decoded===path)return url.pathname+url.search+url.hash;
      path=decoded;
    }
    return null;
  } catch {return null;}
}
