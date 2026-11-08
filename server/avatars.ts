import {createHash} from "node:crypto";
export type AvatarSettings={showAvatars?:boolean;defaultAvatar?:string;avatarRating?:string};
/** Matches the supplied source's SHA-256 Gravatar URL and service defaults. */
export function avatarURL(email:string,settings:AvatarSettings,size=96){
  if(settings.showAvatars===false)return null;
  const hash=createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  const defaults=new Set(["blank","identicon","wavatar","monsterid","retro"]);
  const fallback=defaults.has(settings.defaultAvatar || "")?settings.defaultAvatar!:"mm";
  const rating=["G","PG","R","X"].includes(settings.avatarRating || "")?settings.avatarRating!.toLowerCase():"g";
  return `https://secure.gravatar.com/avatar/${hash}?s=${Math.max(1,Math.min(512,Math.trunc(size)))}&d=${fallback}&r=${rating}`;
}
