import {civilFromInstant} from "./post-civil-date.js";

/** Source save-time policy, independent of the exact-due scheduler. Both
 * instants are explicit: reading the clock belongs to the caller after waits. */
export function publicationStatusAt<T extends string>(status:T,selectedGMT:string|Date|null,now:Date):T|"publish"|"future"{
 if(status!=="publish" && status!=="future")return status;
 if(!(now instanceof Date) || !Number.isFinite(now.valueOf()))throw new Error("Use a valid explicit publication clock.");
 if(selectedGMT===null)throw new Error("Resolve selected publication GMT before classifying status.");
 civilFromInstant(selectedGMT,"UTC");
 const seconds=Math.floor(new Date(selectedGMT).valueOf()/1000)-Math.floor(now.valueOf()/1000);
 return seconds>=60?"future":"publish";
}
