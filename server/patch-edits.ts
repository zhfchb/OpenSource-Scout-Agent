import type { Snapshot } from './github.js';
import { DomainError } from './network.js';
import { patchPath, type PlanContent, type PatchOutput } from './patch.js';

// Model edits are data only. Build a text diff in memory; never apply or execute it.
export function materializeEdits(value: unknown, source: Snapshot, plan: PlanContent): PatchOutput {
  const v = value as { edits: {path:string; oldText:string; newText:string}[]; prTitle:string; prBody:string };
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['edits','prTitle','prBody'].includes(k)) || !Array.isArray(v.edits) || !v.edits.length || v.edits.length > 50 || typeof v.prTitle !== 'string' || typeof v.prBody !== 'string') throw new DomainError('INVALID_PATCH_OUTPUT',502);
  const changes = new Map<string, {start:number;end:number;text:string}[]>();
  for (const edit of v.edits) {
    if (!edit || typeof edit !== 'object' || Object.keys(edit).some(k => !['path','oldText','newText'].includes(k)) || typeof edit.path !== 'string' || !patchPath(edit.path) || !plan.allowedPaths.includes(edit.path)) throw new DomainError('PATCH_SCOPE_REQUIRES_NEW_PLAN',409);
    const file = source.files.find(f => f.path === edit.path);
    if (!file) throw new DomainError('PATCH_SOURCE_UNAVAILABLE',409);
    if (typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string' || edit.oldText === edit.newText || /[\r\0]/.test(edit.oldText + edit.newText)) throw new DomainError('INVALID_PATCH_EDIT',502);
    const start = file.content.indexOf(edit.oldText);
    if (start < 0 || file.content.indexOf(edit.oldText,start+1) >= 0) throw new DomainError('PATCH_EDIT_NOT_UNIQUE',502);
    const list = changes.get(edit.path) || [];
    const end = start + edit.oldText.length;
    if (list.some(e => start < e.end && end > e.start)) throw new DomainError('PATCH_EDITS_OVERLAP',502);
    list.push({start,end,text:edit.newText}); changes.set(edit.path,list);
  }
  let diff = '';
  for (const [path, edits] of changes) {
    const before = source.files.find(f => f.path === path)!.content;
    let after = before;
    for (const e of edits.sort((a,b)=>b.start-a.start)) after=after.slice(0,e.start)+e.text+after.slice(e.end);
    // Preserve EOF convention so a context line cannot represent two EOF states.
    if (!after || before.endsWith('\n') !== after.endsWith('\n')) throw new DomainError('PATCH_EDIT_EOF_CHANGED',502);
    const lines=(text:string)=>{const result=text.split('\n');if(text.endsWith('\n'))result.pop();return result;};
    const a=lines(before),b=lines(after);let prefix=0,suffix=0;
    while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix])prefix++;
    while(suffix<Math.min(a.length,b.length)-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
    if(prefix===a.length&&prefix===b.length)throw new DomainError('EMPTY_PATCH',502);
    const start=Math.max(0,prefix-3),tail=Math.min(3,suffix),oldEnd=a.length-suffix+tail,newEnd=b.length-suffix+tail;
    const oldCount=oldEnd-start,newCount=newEnd-start;
    diff+=`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${oldCount?start+1:start},${oldCount} +${newCount?start+1:start},${newCount} @@\n`;
    const emit=(kind:string,text:string,index:number,total:number)=>{diff+=kind+text+'\n';if(index===total-1&&!before.endsWith('\n'))diff+='\\ No newline at end of file\n';};
    for(let i=start;i<prefix;i++)emit(' ',a[i],i,a.length);
    for(let i=prefix;i<a.length-suffix;i++)emit('-',a[i],i,a.length);
    for(let i=prefix;i<b.length-suffix;i++)emit('+',b[i],i,b.length);
    for(let i=0;i<tail;i++){const index=a.length-suffix+i;emit(' ',a[index],index,a.length);}
  }
  return {diff,prTitle:v.prTitle,prBody:v.prBody};
}
