import { builtinContentTypeKeys } from "./content-registry.js";
import {Router} from "express";
import type {PoolClient} from "pg";
import {z} from "zod";
import {pool,getSettings} from "./db.js";
import {getBundledTheme} from "./themes.js";
import {requireRole} from "./auth.js";
import {HttpError} from "./utils.js";
export async function availablePostTemplates(type:"post"|"page",db:Pick<PoolClient,"query">=pool){
 const settings=await getSettings(db),custom=(getBundledTheme(settings.theme)?.themeJSON.customTemplates || []) as {name:string;title:string;postTypes?:string[]}[];
 const declared=custom.filter(template=>(template.postTypes || ["page"]).includes(type));
 const rows=(await db.query('SELECT id,slug,title,source_hash AS "sourceHash" FROM site_documents WHERE theme=$1 AND type=\'template\' ORDER BY title,id',[settings.theme])).rows;
 return rows.filter(row=>!row.sourceHash || declared.some(template=>template.name===row.slug)).map(row=>({id:row.id,slug:row.slug,title:declared.find(template=>template.name===row.slug)?.title || row.title}));
}
export async function validatePostTemplate(slug:string,type:"post"|"page",db:Pick<PoolClient,"query">){
 if(slug && !(await availablePostTemplates(type,db)).some(template=>template.slug===slug))throw new HttpError(400,"Choose an available template for this content type and active theme.");
}
const router=Router();
router.get("/posts/templates",requireRole("administrator","editor","author","contributor"),async(req,res)=>{
 const type=z.enum(builtinContentTypeKeys).default("post").parse(req.query.type);res.json({templates:await availablePostTemplates(type)});
});
export default router;
