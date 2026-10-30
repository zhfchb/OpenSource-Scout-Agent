// Explicit read-only GitHub acceptance. No model credentials or model calls.
import {mkdirSync,writeFileSync} from 'node:fs';
import {openDatabase} from '../dist/server/db.js';
import {TaskService} from '../dist/server/tasks.js';
import {DiscoveryService} from '../dist/server/discovery.js';
import {profileDefaults} from '../dist/server/discovery-profile.js';
import {randomUUID} from 'node:crypto';
const directory='data/live-m5-'+Date.now();mkdirSync(directory,{recursive:true});
const db=openDatabase(directory+'/scout.sqlite'),tasks=new TaskService(db),d=new DiscoveryService(db,tasks);
const manualOnly=process.env.SCOUT_LIVE_MANUAL_ONLY==='1';
const now=Date.now(),hour=(new Date(now).getUTCHours()+1)%24;
const profile={...profileDefaults,languages:['Java'],minStars:10000,maxStars:20000,maxRepos:manualOnly?20:3,maxIssues:30,repoPages:1,issuePages:1,httpAttempts:15,dailyHttp:100,scheduleEnabled:!manualOnly,utcHour:hour,evaluationEnabled:false};
const evidence={source:'LIVE_API',startedAt:new Date().toISOString(),modelCalls:'NOT_RUN',directory,profile,manual:[],scheduled:null,candidate:null,recheck:null,error:null};
const save=()=>writeFileSync(directory+'/result.json',JSON.stringify(evidence,null,2));
try{
  d.save(profile,0,false,'LOCAL_READ_ONLY_ACCEPTANCE');
  for(let round=0;round<2;round++){const run=d.start(randomUUID(),1);await d.idle();evidence.manual.push({...d.run(run.id),stableCandidateIds:db.prepare('SELECT issue_id FROM discovery_candidates ORDER BY issue_id LIMIT 200').all().map(x=>x.issue_id)});}
  const c=d.candidates().items[0];
  if(c){evidence.candidate={issueId:c.issue_id,repoId:c.repo_id,url:c.url,title:c.title};
    d.action(c.issue_id,'ignore',c.version);evidence.ignoredPersisted=d.candidate(c.issue_id).visibility==='IGNORED';
    const ignored=d.candidate(c.issue_id);d.action(c.issue_id,'enable',ignored.version);
    const selection=d.select(c.issue_id,randomUUID(),1);await new Promise(r=>setImmediate(r));await d.idle();evidence.recheck=d.selection(selection.id);
  }
  save();console.log(JSON.stringify({phase:'MANUAL_FINISHED',file:directory+'/result.json',candidates:d.candidates().items.length,statuses:evidence.manual.map(x=>x.status),nextDueAt:d.profile().control.next_due_at}));
  if(!manualOnly){d.startScheduler();
  const deadline=d.profile().control.next_due_at+90000;
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));const scheduled=d.runs().find(x=>x.trigger==='SCHEDULE');if(scheduled&&!['QUEUED','RUNNING'].includes(scheduled.status)){evidence.scheduled=d.run(scheduled.id);break;}}}
}catch(error){evidence.error=error?.code||'LIVE_REQUEST_FAILED';}
finally{evidence.finishedAt=new Date().toISOString();save();await d.close();await tasks.close();db.close();console.log(JSON.stringify({phase:'FINISHED',file:directory+'/result.json',error:evidence.error,scheduled:evidence.scheduled?.status||'NOT_RUN'}));}
