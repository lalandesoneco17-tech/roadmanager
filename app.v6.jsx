const {useState,useEffect,useRef,useCallback,useMemo}=React;
const C={bg:'#334155',card:'#fff',border:'#cbd5e1',accent:'#008965',green:'#16a34a',red:'#dc2626',orange:'#d97706',purple:'#9333ea',cyan:'#0891b2',text:'#1e293b',dim:'#64748b',muted:'#94a3b8'};
const MC={Raboteuse:'#008965',Balayeuse:'#16a34a',Citerne:'#0891b2'};
const FC={'2h':'#6b7280','4h':'#008965','6h':'#d97706','8h':'#16a34a','Transfert':'#9333ea','Demi-journee':'#d97706','Journee':'#16a34a'};
const SKEY='roadmanager-v5';
if(!window.storage||typeof window.storage.get!=='function'){window.storage={get:function(k){try{return Promise.resolve(localStorage.getItem(k))}catch(e){return Promise.resolve(null)}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}return Promise.resolve()}};}
const uid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const defaultData=()=>({depots:[],employees:[],machines:[],trucks:[],cars:[],clients:[],jobs:[],forfaits:{},timeEntries:[],timeEntriesValidated:[],parts:[],interventions:[],panneReports:[],jdReports:[],fuelPrice:1.72,nightPct:30,adminUser:'admin',adminPass:'admin',empPasswords:{},workDaysPerMonth:22,monthlyRent:0,monthlyAdmin:0,monthlyInsuranceRC:0,yearStart:fmtDateISO(new Date(new Date().getFullYear(),0,1)),weeklyHoursNormal:35,overtime25Threshold:35,overtime50Threshold:43,refHoursPerDay:1,nightStart:'21:00',nightEnd:'06:00',paniersPrice:12,restoPrice:15,anthropicApiKey:'',machineReports:[],equipmentLists:{Raboteuse:[],Balayeuse:[],Citerne:[]},machineEquipmentStatus:{},maintenanceRequests:[]});
const PART_CATS=['pneu','filtre','courroie','dent','roulement','electrique','hydraulique','autre'];
const INTER_TYPES=['reparation','entretien','changement_piece','panne'];
const SEVERITIES=['urgent','normal','mineur'];
const sb=window.supabaseClient;
// localStorage helpers
const localLoad=()=>{try{for(const k of[SKEY,'roadmanager-v4','roadmanager-v3','roadmanager-v2','roadmanager-data']){const raw=localStorage.getItem(k);if(raw){const d=JSON.parse(raw);if(k!==SKEY)localStorage.setItem(SKEY,JSON.stringify(d));return{...defaultData(),...d};}}}catch(e){}return null};
const localSave=(d)=>{try{localStorage.setItem(SKEY,JSON.stringify(d))}catch(e){}};
// Supabase load/save with localStorage fallback
const loadData=async()=>{if(sb){try{const{data:row,error}=await sb.from('app_data').select('data').eq('id','main').single();if(!error&&row&&row.data&&Object.keys(row.data).length>0){const merged={...defaultData(),...row.data};localSave(merged);console.log('Loaded from Supabase');return merged}}catch(e){console.warn('Supabase load failed, fallback localStorage',e)}}const local=localLoad();if(local){if(sb){try{await sb.from('app_data').upsert({id:'main',data:local,updated_at:new Date().toISOString()});console.log('Migrated localStorage to Supabase')}catch(e){console.warn('Migration to Supabase failed',e)}}return local}return defaultData()};
const mergeArraysById=(local,remote)=>{if(!remote||!remote.length)return local||[];if(!local||!local.length)return remote;const map=new Map();remote.forEach(item=>{if(item&&item.id)map.set(item.id,item)});local.forEach(item=>{if(item&&item.id)map.set(item.id,item)});return[...map.values()]};
const mergeKeepLocal=(local,remote)=>{if(!remote||!remote.length)return local||[];if(!local)return[];const localIds=new Set((local||[]).filter(x=>x&&x.id).map(x=>x.id));const merged=new Map();(local||[]).forEach(item=>{if(item&&item.id)merged.set(item.id,item)});(remote||[]).forEach(item=>{if(item&&item.id&&!merged.has(item.id)&&!localIds.has(item.id)){/* item deleted locally, skip */}else if(item&&item.id&&!merged.has(item.id)){merged.set(item.id,item)}});return[...merged.values()]};
const saveData=async(d)=>{localSave(d);if(sb){try{const{data:row}=await sb.from('app_data').select('data').eq('id','main').single();if(row&&row.data){const remote=row.data;const merged={...d};merged.timeEntries=d.timeEntries||[];merged.panneReports=mergeArraysById(d.panneReports,remote.panneReports);merged.interventions=mergeKeepLocal(d.interventions,remote.interventions);merged.parts=mergeKeepLocal(d.parts,remote.parts);const{error}=await sb.from('app_data').upsert({id:'main',data:merged,updated_at:new Date().toISOString()});if(error)console.error('Supabase save error:',error);else{localSave(merged);console.log('Saved to Supabase (merged)')}}else{const{error}=await sb.from('app_data').upsert({id:'main',data:d,updated_at:new Date().toISOString()});if(error)console.error('Supabase save error:',error);else console.log('Saved to Supabase')}}catch(e){console.warn('Supabase save failed',e)}}};
const subscribeToChanges=(callback,getCurrentData)=>{if(!sb)return()=>{};const channel=sb.channel('app_data_changes').on('postgres_changes',{event:'UPDATE',schema:'public',table:'app_data',filter:'id=eq.main'},(payload)=>{if(payload.new&&payload.new.data){const remote={...defaultData(),...payload.new.data};const current=getCurrentData?getCurrentData():null;if(!current){localSave(remote);callback(remote);return}const merged={...remote};merged.timeEntries=mergeArraysById(current.timeEntries,remote.timeEntries);merged.panneReports=mergeArraysById(current.panneReports,remote.panneReports);localSave(merged);callback(merged)}}).subscribe();return()=>{sb.removeChannel(channel)}};

// ========== POINTAGE FIABLE (tables dediees time_entries / time_entries_validated) ==========
// Chaque pointage = une ligne Supabase independante -> zero race condition entre salaries.
// File d'attente localStorage + flush auto en cas de coupure reseau.
// Soft-delete (champ deleted=true) : un pointage n'est jamais efface physiquement.
const TE_QUEUE_KEY='rm-te-queue';
const teQueueGet=()=>{try{return JSON.parse(localStorage.getItem(TE_QUEUE_KEY)||'[]')}catch(e){return[]}};
const teQueueSet=q=>{try{localStorage.setItem(TE_QUEUE_KEY,JSON.stringify(q))}catch(e){}};
const teQueuePush=op=>{const q=teQueueGet();q.push({...op,_ts:Date.now()});teQueueSet(q)};
const teTableOf=key=>key==='timeEntriesValidated'?'time_entries_validated':'time_entries';
const teToRow=e=>({id:e.id,emp_id:e.empId,date:e.date,type:e.type||null,start_time:e.startTime||null,end_time:e.endTime||null,pause_start:e.pauseStart||null,pause_end:e.pauseEnd||null,pause_min:e.pauseMin||0,break_start:e.breakStart||null,break_end:e.breakEnd||null,meal_type:e.mealType||null,absence_type:e.absenceType||null,night_hours:e.nightHours||0,requested_end_time:e.requestedEndTime||null,requested_end_motif:e.requestedEndMotif||null,ref_hours:e.refHours!=null?e.refHours:null,created_at:e.createdAt||new Date().toISOString(),updated_at:new Date().toISOString(),deleted:false});
const teFromRow=r=>({id:r.id,empId:r.emp_id,date:r.date,type:r.type||'',startTime:r.start_time||'',endTime:r.end_time||'',pauseStart:r.pause_start||null,pauseEnd:r.pause_end||null,pauseMin:r.pause_min||0,breakStart:r.break_start||'',breakEnd:r.break_end||'',mealType:r.meal_type||'',absenceType:r.absence_type||'',nightHours:Number(r.night_hours)||0,requestedEndTime:r.requested_end_time||'',requestedEndMotif:r.requested_end_motif||'',refHours:r.ref_hours!=null?Number(r.ref_hours):undefined,createdAt:r.created_at});
let teTablesAvailable=null;
const teTestTables=async()=>{if(!sb)return false;if(teTablesAvailable!==null)return teTablesAvailable;try{const{error}=await sb.from('time_entries').select('id').limit(1);teTablesAvailable=!error;if(error)console.warn('time_entries table pas encore creee:',error.message);else console.log('time_entries tables OK');return teTablesAvailable}catch(e){teTablesAvailable=false;return false}};
const teUpsertRemote=async(entry,table)=>{if(!sb)return false;try{const{error}=await sb.from(table).upsert(teToRow(entry),{onConflict:'id'});if(error){console.error('TE upsert err',table,error);return false}return true}catch(e){console.warn('TE upsert exc',e);return false}};
const teDeleteRemote=async(id,table)=>{if(!sb)return false;try{const{error}=await sb.from(table).update({deleted:true,updated_at:new Date().toISOString()}).eq('id',id);if(error){console.error('TE del err',table,error);return false}return true}catch(e){console.warn('TE del exc',e);return false}};
const teLoadAll=async(table)=>{if(!sb)return null;try{const{data,error}=await sb.from(table).select('*').eq('deleted',false);if(error){console.warn('TE load err',table,error);return null}return(data||[]).map(teFromRow)}catch(e){console.warn('TE load exc',e);return null}};
const teQueueFlush=async()=>{if(!sb)return;const avail=await teTestTables();if(!avail)return;const q=teQueueGet();if(!q.length)return;const remaining=[];for(const op of q){let ok=false;if(op.kind==='upsert')ok=await teUpsertRemote(op.entry,op.table);else if(op.kind==='delete')ok=await teDeleteRemote(op.id,op.table);if(!ok)remaining.push(op)}teQueueSet(remaining);if(remaining.length<q.length)console.log('TE queue flushed:',q.length-remaining.length,'envoyes, restantes:',remaining.length)};
const teSyncChanges=async(oldData,newData)=>{if(!sb)return;const avail=await teTestTables();for(const key of['timeEntries','timeEntriesValidated']){const table=teTableOf(key);const oldMap=new Map(((oldData||{})[key]||[]).filter(t=>t&&t.id).map(t=>[t.id,t]));const nextMap=new Map(((newData||{})[key]||[]).filter(t=>t&&t.id).map(t=>[t.id,t]));for(const[id,entry]of nextMap){const prev=oldMap.get(id);if(!prev||JSON.stringify(prev)!==JSON.stringify(entry)){if(avail){const ok=await teUpsertRemote(entry,table);if(!ok)teQueuePush({kind:'upsert',entry,table})}else{teQueuePush({kind:'upsert',entry,table})}}}for(const[id]of oldMap){if(!nextMap.has(id)){if(avail){const ok=await teDeleteRemote(id,table);if(!ok)teQueuePush({kind:'delete',id,table})}else{teQueuePush({kind:'delete',id,table})}}}}};
const teMigrateFromBlob=async(data)=>{if(!sb||!data)return data;const avail=await teTestTables();if(!avail)return data;const merged={...data};for(const key of['timeEntries','timeEntriesValidated']){const table=teTableOf(key);const remote=await teLoadAll(table);if(remote===null){merged[key]=data[key]||[];continue}const remoteMap=new Map(remote.map(t=>[t.id,t]));let allIds=null;try{const{data:allRows}=await sb.from(table).select('id');if(allRows)allIds=new Set(allRows.map(r=>r.id))}catch(e){}const blobEntries=(data[key]||[]).filter(t=>t&&t.id);const toMigrate=blobEntries.filter(t=>!remoteMap.has(t.id)&&(!allIds||!allIds.has(t.id)));if(toMigrate.length){console.log('Migration de',toMigrate.length,key,'vers',table);for(const e of toMigrate){const ok=await teUpsertRemote(e,table);if(ok)remoteMap.set(e.id,e);else teQueuePush({kind:'upsert',entry:e,table})}}merged[key]=[...remoteMap.values()]}return merged};
const teSubscribe=onChange=>{if(!sb)return()=>{};const ch=sb.channel('te_changes').on('postgres_changes',{event:'*',schema:'public',table:'time_entries'},p=>onChange('time_entries',p)).on('postgres_changes',{event:'*',schema:'public',table:'time_entries_validated'},p=>onChange('time_entries_validated',p)).subscribe();return()=>{try{sb.removeChannel(ch)}catch(e){}}};
if(typeof window!=='undefined'&&!window.__teOnlineBound){window.__teOnlineBound=true;window.addEventListener('online',()=>{teQueueFlush().catch(()=>{})})}
// ========== FIN POINTAGE FIABLE ==========

const pad2=n=>String(n).padStart(2,'0');
const fmtDate=d=>{const dt=new Date(d);const j=['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];const m=['Jan','Fev','Mar','Avr','Mai','Jun','Jul','Aou','Sep','Oct','Nov','Dec'];return j[dt.getDay()]+' '+dt.getDate()+' '+m[dt.getMonth()]+' '+dt.getFullYear()};
const fmtDateISO=d=>{const dt=new Date(d);return dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate())};
const fmtMoney=n=>Number(n||0).toFixed(2).replace('.',',')+' EUR';
const fmtDuration=min=>{const h=Math.floor(min/60);const m=Math.round(min%60);return h+'h'+pad2(m)};
// Calcul d'heures travaillees pour un pointage. Gere le passage minuit (ex: 20h->5h = 9h).
const calcWorkedMin=t=>{if(!t||!t.startTime||!t.endTime)return 0;const[sh,sm]=t.startTime.split(':').map(Number);const[eh,em]=t.endTime.split(':').map(Number);let mins=(eh*60+em)-(sh*60+sm);if(mins<0)mins+=24*60;return Math.max(0,mins-(t.pauseMin||0))};
// Heures de nuit en décimal entre startTime et endTime, selon la plage [nightStart, nightEnd[ (peut wrap minuit, ex: 21h->06h).
// Gère aussi un shift qui traverse minuit. Ne déduit pas la pause (rare qu'elle tombe en pleine nuit).
const calcNightHours=(startTime,endTime,nightStart,nightEnd)=>{if(!startTime||!endTime||!nightStart||!nightEnd)return 0;const toMin=t=>{const[h,m]=t.split(':').map(Number);return h*60+m};let s=toMin(startTime),e=toMin(endTime);if(e<=s)e+=1440;const ns=toMin(nightStart),ne=toMin(nightEnd);const segs=d=>ns<ne?[[d+ns,d+ne]]:[[d+ns,d+1440],[d,d+ne]];const inter=(a,b)=>Math.max(0,Math.min(a[1],b[1])-Math.max(a[0],b[0]));let total=0;for(let d=0;d<=1440;d+=1440)segs(d).forEach(sg=>total+=inter([s,e],sg));return Math.round(total/60*100)/100};
// Pâques (algorithme de Meeus/Gauss) -> Date
const easterDate=(y)=>{const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;return new Date(y,mo-1,da)};
// Jour férié français pour une date ISO (YYYY-MM-DD) -> nom ou null
const getFrenchHoliday=(dateStr)=>{if(!dateStr)return null;const d=new Date(dateStr);if(isNaN(d))return null;const y=d.getFullYear();const md=String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');const fixed={'01-01':'Jour de l\'An','05-01':'Fete du Travail','05-08':'Victoire 1945','07-14':'Fete nationale','08-15':'Assomption','11-01':'Toussaint','11-11':'Armistice','12-25':'Noel'};if(fixed[md])return fixed[md];const eDay=Math.floor(easterDate(y).getTime()/86400000);const dDay=Math.floor(d.getTime()/86400000);if(dDay===eDay+1)return'Lundi de Paques';if(dDay===eDay+39)return'Ascension';if(dDay===eDay+50)return'Lundi de Pentecote';return null};
// Heures de référence selon le jour de la semaine : lun-jeu = 8h, ven = 7h, sam/dim = 0
const getDayRefHours=(dateStr)=>{if(!dateStr)return 0;const d=new Date(dateStr);if(isNaN(d))return 0;const dow=d.getDay();if(dow===0||dow===6)return 0;if(dow===5)return 7;return 8};
const calcDiffMin=(start,end)=>{if(!start||!end)return 0;const[sh,sm]=start.split(':').map(Number);const[eh,em]=end.split(':').map(Number);let m=(eh*60+em)-(sh*60+sm);if(m<0)m+=24*60;return m};
const parseCoords=s=>{if(!s)return null;const p=String(s).split(',').map(Number);return p.length===2&&!isNaN(p[0])&&!isNaN(p[1])?p:null};
const haversine=(a,b)=>{const R=6371,toR=n=>n*Math.PI/180;const dLat=toR(b[0]-a[0]),dLon=toR(b[1]-a[1]);const x=Math.sin(dLat/2)**2+Math.cos(toR(a[0]))*Math.cos(toR(b[0]))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))};
const osmRoute=async(from,to)=>{const urls=[`https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=false`,`https://routing.openstreetmap.de/routed-car/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=false`];for(const url of urls){try{const r=await fetch(url);const j=await r.json();if(j.routes&&j.routes[0])return{km:+(j.routes[0].distance/1000).toFixed(1),min:+(j.routes[0].duration/60).toFixed(0)}}catch(e){}}const km=+(haversine(from,to)*1.3).toFixed(1);return{km,min:+((km/80)*60).toFixed(0)}};
const searchAddress=async q=>{try{const r=await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=fr&limit=5&q=${encodeURIComponent(q)}`);return await r.json()}catch(e){return[]}};
const getDepotCoords=(data,id)=>{const d=(data.depots||[]).find(x=>x.id===id);if(!d||!d._coords)return null;return parseCoords(typeof d._coords==='string'?d._coords:d._coords.join(','))};
const getEmpCoords=(data,id)=>{const e=(data.employees||[]).find(x=>x.id===id);if(!e||!e._coords)return null;return parseCoords(typeof e._coords==='string'?e._coords:e._coords.join(','))};
const getStartCoords=(data,job)=>job.startFrom==='home'?getEmpCoords(data,job.employeeId):getDepotCoords(data,job.startFrom);
const getEndCoords=(data,job)=>job.endAt==='home'?getEmpCoords(data,job.employeeId):getDepotCoords(data,job.endAt);
const getMachineFuelType=(data,mid)=>{const m=(data.machines||[]).find(x=>x.id===mid);return m&&m.type==='Raboteuse'?'gazole':'gnr'};
const getFuelPrice=(data,ft,did)=>{if(did){const d=(data.depots||[]).find(x=>x.id===did);if(d){if(ft==='gnr'&&d.gnrPrice>0)return d.gnrPrice;if(ft==='gazole'&&d.gazolePrice>0)return d.gazolePrice;}}for(const d of(data.depots||[])){if(ft==='gnr'&&d.gnrPrice>0)return d.gnrPrice;if(ft==='gazole'&&d.gazolePrice>0)return d.gazolePrice;}return data.fuelPrice||1.72};
const getForfaitKey=(data,cid,machine)=>{const cl=(data.clients||[]).find(x=>x.id===cid);const p=(cl&&cl.forfaitType==='specific')?cid:'standard';if(!machine)return null;if(machine.type==='Raboteuse')return p+'_rab_'+(machine.width||'');if(machine.type==='Balayeuse')return p+'_bal';if(machine.type==='Citerne')return p+'_cit';return null};
const getForfaitPrice=(data,cid,machine,ft,citOpt,isNight)=>{let k=getForfaitKey(data,cid,machine);if(!k)return 0;if(machine&&machine.type==='Citerne'&&citOpt)k+='_'+citOpt;const g=data.forfaits[k];if(!g)return 0;let pr=g[ft]||0;if(isNight)pr=pr*(1+(data.nightPct||30)/100);return Math.round(pr*100)/100};
const getTransferPrice=(data,cid,machine,citOpt,isNight)=>getForfaitPrice(data,cid,machine,'Transfert',citOpt,isNight);
const forfaitHours=f=>({'2h':2,'4h':4,'6h':6,'8h':8,'Demi-journee':4,'Journee':8}[f]||4);

const TEMPS_PLUS_DEPART=25;
const TEMPS_PLUS_ARRIVEE=30;
const TOLERANCE_MINUTES=5;

const calcTheoreticalTimes=(job,data,pauseMinFromTE)=>{
const tpDepart=(data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART);
const tpArrivee=(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const tol=(data.toleranceMinutes!=null?data.toleranceMinutes:TOLERANCE_MINUTES);
if(!job.billingStart)return null;
const[bh,bm]=(job.billingStart||'08:00').split(':').map(Number);
if(isNaN(bh)||isNaN(bm))return null;
const billMin=bh*60+bm;
const trajetAller=Number(job.travelMinAller)||0;
const trajetRetour=Number(job.travelMinRetour)||0;
const startMin=billMin-trajetAller-tpDepart;
const fh=forfaitHours(job.forfaitType);
const pMin=Number(pauseMinFromTE)||0;
const endMin=billMin+fh*60+pMin+trajetRetour+tpArrivee;
const fmtT=m=>{const mm=((m%1440)+1440)%1440;return pad2(Math.floor(mm/60))+':'+pad2(mm%60)};
return{theoStart:fmtT(startMin),theoEnd:fmtT(endMin),theoStartMin:startMin,theoEndMin:endMin,tolerance:tol};
};

const Mod=({title,onClose,children,width})=>(
<div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}} onClick={onClose}>
<div style={{background:'#fff',borderRadius:12,padding:24,width:width||500,maxWidth:'95vw',maxHeight:'90vh',overflow:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}} onClick={e=>e.stopPropagation()}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
<h3 style={{margin:0,fontSize:18}}>{title}</h3>
<button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.dim}}>x</button>
</div>{children}</div></div>
);
// Modal carte SYNTHÈSE : trajets de toutes les machines du jour, chacune avec sa couleur
const MapModalGlobal=({onClose,selDate,tracks})=>{
const mapRef=useRef(null);
useEffect(()=>{
  if(!window.L||!mapRef.current||!tracks||!tracks.length)return;
  const L=window.L;
  const map=L.map(mapRef.current).setView([45.6,-0.5],8); // fallback centre France-Ouest
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);
  const allLatLngs=[];
  tracks.forEach(t=>{
    if(!t.rawPts||!t.rawPts.length)return;
    const latlngs=t.rawPts.map(p=>[p.lat,p.lon]);
    allLatLngs.push(...latlngs);
    L.polyline(latlngs,{color:t.color,weight:3,opacity:0.7}).addTo(map).bindPopup('<b>'+t.machineName+'</b>');
    if(t.centroid){
      const ic=L.divIcon({className:'',html:'<div style="background:'+t.color+';color:#fff;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 4px rgba(0,0,0,0.3)">'+t.label+'</div>',iconSize:[30,30],iconAnchor:[15,15]});
      L.marker([t.centroid.lat,t.centroid.lon],{icon:ic}).addTo(map).bindPopup('<b>'+t.machineName+'</b><br/>'+(t.workStart?'⚙️ '+t.workStart+' → 🏁 '+t.workEnd:''));
    }
  });
  if(allLatLngs.length)map.fitBounds(allLatLngs,{padding:[40,40]});
  return()=>{map.remove()};
},[tracks]);
return(<div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2000}} onClick={onClose}>
<div onClick={e=>e.stopPropagation()} style={{background:'#fff',borderRadius:10,padding:14,width:'95vw',height:'90vh',maxWidth:1400,display:'flex',flexDirection:'column'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
<h3 style={{margin:0,fontSize:16}}>🗺 Carte du jour — {selDate} · {tracks.length} machine(s)</h3>
<button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.dim}}>×</button>
</div>
<div ref={mapRef} style={{flex:1,borderRadius:8,overflow:'hidden'}}/>
<div style={{marginTop:8,fontSize:11,color:C.dim,display:'flex',gap:14,flexWrap:'wrap'}}>
{tracks.map((t,i)=><span key={i}><span style={{display:'inline-block',width:12,height:12,background:t.color,borderRadius:6,verticalAlign:'middle',marginRight:4}}/>{t.machineName}</span>)}
</div>
</div>
</div>);
};
// Modal carte Leaflet : affiche le trajet GPS d'une mission Wirtgen avec marqueurs dépôt/chantier/pauses
const MapModal=({onClose,title,rawPts,centroid,depotGps,pauses,siteArrival,siteDeparture,workStart,workEnd})=>{
const mapRef=useRef(null);
useEffect(()=>{
  if(!window.L||!mapRef.current||!rawPts||!rawPts.length)return;
  const L=window.L;
  const map=L.map(mapRef.current).setView([centroid?centroid.lat:rawPts[0].lat,centroid?centroid.lon:rawPts[0].lon],13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);
  // Trajet GPS complet en ligne bleue
  const latlngs=rawPts.map(p=>[p.lat,p.lon]);
  L.polyline(latlngs,{color:'#3b82f6',weight:3,opacity:0.6}).addTo(map);
  // Marqueurs début/fin trajet
  const startPt=rawPts[0],endPt=rawPts[rawPts.length-1];
  L.marker([startPt.lat,startPt.lon],{title:'Début données GPS ('+startPt.hhmm+')'}).addTo(map).bindPopup('🏁 Début données GPS — '+startPt.hhmm);
  L.marker([endPt.lat,endPt.lon],{title:'Fin données GPS ('+endPt.hhmm+')'}).addTo(map).bindPopup('🏁 Fin données GPS — '+endPt.hhmm);
  // Centroïde chantier
  if(centroid){
    const chantierIcon=L.divIcon({className:'',html:'<div style="background:#dc2626;color:#fff;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)">⚙️</div>',iconSize:[36,36],iconAnchor:[18,18]});
    L.marker([centroid.lat,centroid.lon],{icon:chantierIcon}).addTo(map).bindPopup('⚙️ <b>Chantier</b><br/>'+(workStart?'Début fraisage : '+workStart+'<br/>':'')+(workEnd?'Fin fraisage : '+workEnd:''));
  }
  // Dépôt
  if(depotGps){
    const depotIcon=L.divIcon({className:'',html:'<div style="background:#1d4ed8;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)">🏠</div>',iconSize:[32,32],iconAnchor:[16,16]});
    L.marker([depotGps.lat,depotGps.lon],{icon:depotIcon}).addTo(map).bindPopup('🏠 <b>Dépôt</b>');
  }
  // Pauses
  (pauses||[]).forEach(p=>{
    const pIcon=L.divIcon({className:'',html:'<div style="background:#eab308;color:#000;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid #fff;box-shadow:0 2px 4px rgba(0,0,0,0.3)">⏸</div>',iconSize:[28,28],iconAnchor:[14,14]});
    const dh=Math.floor(p.durationMin/60),dm=p.durationMin%60;const dur=dh>0?dh+'h'+String(dm).padStart(2,'0'):dm+'min';
    L.marker([p.lat,p.lon],{icon:pIcon}).addTo(map).bindPopup('⏸ <b>Pause '+dur+'</b><br/>'+p.startHhmm+' → '+p.endHhmm);
  });
  // Fit bounds sur tous les pts
  map.fitBounds(latlngs,{padding:[40,40]});
  return()=>{map.remove()};
},[rawPts,centroid,depotGps,pauses]);
return(<div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2000}} onClick={onClose}>
<div onClick={e=>e.stopPropagation()} style={{background:'#fff',borderRadius:10,padding:14,width:'90vw',height:'85vh',maxWidth:1200,display:'flex',flexDirection:'column'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
<h3 style={{margin:0,fontSize:16}}>🗺 Trajet — {title}</h3>
<button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.dim}}>×</button>
</div>
<div ref={mapRef} style={{flex:1,borderRadius:8,overflow:'hidden'}}/>
<div style={{marginTop:8,fontSize:11,color:C.dim,display:'flex',gap:14,flexWrap:'wrap'}}>
<span>🔵 trajet</span><span>🏠 dépôt</span><span>⚙️ chantier</span><span>⏸ pause</span>
</div>
</div>
</div>);
};
// Modal carte planning : affiche tous les chantiers planifiés pour une date donnée (pour optimiser les trajets)
// Note : mk.co et d.co sont des tableaux [lat, lon] (sortie de parseCoords), pas des objets {lat, lon}
const MapModalPlanning=({onClose,selDate,veilleISO,surlendISO,markers,depots,showVeille,showSurlend,onToggleVeille,onToggleSurlend})=>{
const mapRef=useRef(null);
const mapInst=useRef(null);
const markersLayer=useRef(null);
const fittedRef=useRef(false);
const fmtDDMM=iso=>{const d=new Date(iso);return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')};
// Init de la carte une seule fois (au mount) — ne pas la recreer aux changements de markers
useEffect(()=>{
  if(!window.L||!mapRef.current||mapInst.current)return;
  const L=window.L;
  const map=L.map(mapRef.current).setView([45.6,-0.5],8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);
  mapInst.current=map;
  markersLayer.current=L.layerGroup().addTo(map);
  return()=>{map.remove();mapInst.current=null;markersLayer.current=null;fittedRef.current=false};
},[]);
// Update des markers sans toucher au zoom / position courants (fitBounds seulement au 1er rendu)
useEffect(()=>{
  if(!mapInst.current||!markersLayer.current||!window.L)return;
  const L=window.L;
  const map=mapInst.current;
  markersLayer.current.clearLayers();
  const allLatLngs=[];
  (depots||[]).forEach(d=>{
    if(!d.co||d.co.length<2)return;
    allLatLngs.push([d.co[0],d.co[1]]);
    const ic=L.divIcon({className:'',html:'<div style="background:#1d4ed8;color:#fff;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid #fff;box-shadow:0 2px 4px rgba(0,0,0,0.3)">🏠</div>',iconSize:[30,30],iconAnchor:[15,15]});
    L.marker([d.co[0],d.co[1]],{icon:ic}).addTo(markersLayer.current).bindPopup('<b>🏠 '+(d.name||'Dépôt')+'</b>');
  });
  (markers||[]).forEach(mk=>{
    if(!mk.co||mk.co.length<2)return;
    allLatLngs.push([mk.co[0],mk.co[1]]);
    const off=mk.dayOffset||0;
    const op=off===0?1:0.6;
    const borderStyle=off===0?'solid':(off<0?'dashed':'dotted');
    const borderColor=mk.isNight?'#dc2626':'#fff';
    const borderWidth=mk.isNight?3:2;
    const dayBadge=off===0?'':'<span style="background:rgba(0,0,0,0.35);border-radius:6px;padding:0 4px;margin-right:4px;font-size:9px;font-weight:700">'+(off<0?'J-'+Math.abs(off):'J+'+off)+'</span>';
    const nightBadge=mk.isNight?'<span style="background:#dc2626;color:#fff;border-radius:6px;padding:0 4px;margin-right:4px;font-size:9px;font-weight:700">🌙</span>':'';
    const seqPart=mk.seq?'<span style="background:rgba(0,0,0,0.25);border-radius:8px;padding:0 5px;margin-right:4px;font-size:10px">'+mk.seq+'</span>':'';
    const html='<div style="opacity:'+op+';background:'+mk.color+';color:#fff;padding:3px 8px;border-radius:14px;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;font-size:11px;font-weight:800;border:'+borderWidth+'px '+borderStyle+' '+borderColor+';box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:nowrap;line-height:1.15"><div>'+nightBadge+dayBadge+seqPart+mk.mainLabel+'</div>'+(mk.secondLine?'<div style="font-size:10px;font-weight:700;opacity:0.95">'+mk.secondLine+'</div>':'')+(mk.billingStart?'<div style="font-size:9px;font-weight:600;opacity:0.9">'+mk.billingStart+'</div>':'')+'</div>';
    const ic=L.divIcon({className:'',html,iconSize:null,iconAnchor:[40,20]});
    const dayLabel=off===0?'':' ('+(off<0?'J-'+Math.abs(off):'J+'+off)+' · '+(mk.dateISO||'')+')';
    const popup='<div style="min-width:180px"><b style="color:'+mk.color+'">'+(mk.seq?'#'+mk.seq+' · ':'')+mk.machineName+dayLabel+'</b>'+(mk.isNight?'<br/><span style="color:#dc2626;font-weight:700">🌙 NUIT</span>':'')+(mk.driverName?'<br/>👤 '+mk.driverName:'')+(mk.clientName?'<br/>🏢 '+mk.clientName:'')+(mk.location?'<br/>📍 '+mk.location:'')+(mk.billingStart?'<br/>🕐 '+mk.billingStart:'')+(mk.forfaitType?'<br/>📋 '+mk.forfaitType:'')+'</div>';
    L.marker([mk.co[0],mk.co[1]],{icon:ic}).addTo(markersLayer.current).bindPopup(popup);
  });
  if(allLatLngs.length&&!fittedRef.current){map.fitBounds(allLatLngs,{padding:[50,50]});fittedRef.current=true}
},[markers,depots]);
const todayCount=(markers||[]).filter(m=>(m.dayOffset||0)===0).length;
const veilleCount=(markers||[]).filter(m=>m.dayOffset===-1).length;
const surlendCount=(markers||[]).filter(m=>m.dayOffset===1).length;
return(<div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'#000',zIndex:2000}} onClick={onClose}>
<div onClick={e=>e.stopPropagation()} style={{background:'#fff',padding:10,width:'100vw',height:'100vh',display:'flex',flexDirection:'column'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,gap:10,flexWrap:'wrap'}}>
<h3 style={{margin:0,fontSize:16}}>🗺 Carte planning — {selDate} · {todayCount} chantier(s) <span style={{fontSize:10,color:C.dim,fontWeight:400,marginLeft:8}}>v2026.05.27-5</span></h3>
<div style={{display:'flex',gap:6,alignItems:'center'}}>
<button onClick={onToggleVeille} title={'Afficher / masquer les chantiers de la veille ('+veilleISO+')'} style={{padding:'5px 10px',borderRadius:6,border:'2px '+(showVeille?'dashed':'solid')+' '+(showVeille?C.accent:C.muted),background:showVeille?C.accent+'18':'#fff',color:showVeille?C.accent:C.dim,cursor:'pointer',fontSize:12,fontWeight:700}}>{showVeille?'✓ ':''}← Veille {fmtDDMM(veilleISO)}{showVeille?' ('+veilleCount+')':''}</button>
<button onClick={onToggleSurlend} title={'Afficher / masquer les chantiers du lendemain ('+surlendISO+')'} style={{padding:'5px 10px',borderRadius:6,border:'2px '+(showSurlend?'dotted':'solid')+' '+(showSurlend?C.accent:C.muted),background:showSurlend?C.accent+'18':'#fff',color:showSurlend?C.accent:C.dim,cursor:'pointer',fontSize:12,fontWeight:700}}>{showSurlend?'✓ ':''}{fmtDDMM(surlendISO)} Surlend. →{showSurlend?' ('+surlendCount+')':''}</button>
<button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.dim,marginLeft:6}}>×</button>
</div>
</div>
<div ref={mapRef} style={{flex:1,borderRadius:8,overflow:'hidden'}}/>
<div style={{marginTop:8,fontSize:11,color:C.dim,display:'flex',gap:14,flexWrap:'wrap',alignItems:'center'}}>
<span>🏠 dépôt</span>
<span style={{border:'2px solid '+C.dim,borderRadius:8,padding:'1px 6px'}}>jour J</span>
{showVeille&&<span style={{border:'2px dashed '+C.dim,borderRadius:8,padding:'1px 6px',opacity:0.7}}>veille</span>}
{showSurlend&&<span style={{border:'2px dotted '+C.dim,borderRadius:8,padding:'1px 6px',opacity:0.7}}>lendemain</span>}
<span style={{border:'3px solid #dc2626',borderRadius:8,padding:'1px 6px',color:'#dc2626',fontWeight:700}}>🌙 nuit</span>
{(markers||[]).map((m,i)=><span key={i} style={{opacity:(m.dayOffset||0)===0?1:0.6}}><span style={{display:'inline-block',width:12,height:12,background:m.color,borderRadius:6,verticalAlign:'middle',marginRight:4}}/>{(m.dayOffset===-1?'J-1 ':m.dayOffset===1?'J+1 ':'')+(m.seq?'#'+m.seq+' ':'')+m.machineName}{m.driverName?' · '+m.driverName:''}{m.billingStart?' · '+m.billingStart:''}</span>)}
</div>
</div>
</div>);
};
// Modal de choix géocodage : affiche la liste de résultats Nominatim avec département bien visible
const GeocodeChoiceModal=({choice,onPick,onClose})=>{
if(!choice)return null;
// Extrait le numéro de département (code postal débute par 2 chiffres en France)
const getDept=r=>{
  const a=r.address||{};
  if(a.postcode){const cp=String(a.postcode);if(cp.length>=2)return cp.slice(0,2)}
  return null;
};
const getDeptName=r=>{
  const a=r.address||{};
  return a.county||a.state_district||a.state||'';
};
const getCity=r=>{
  const a=r.address||{};
  return a.city||a.town||a.village||a.municipality||a.hamlet||'';
};
return(<div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.6)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2100}} onClick={onClose}>
<div onClick={e=>e.stopPropagation()} style={{background:'#fff',borderRadius:10,padding:18,width:580,maxWidth:'95vw',maxHeight:'85vh',display:'flex',flexDirection:'column'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
<h3 style={{margin:0,fontSize:15}}>📍 Choisir le bon lieu pour "<i>{choice.query}</i>"</h3>
<button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:C.dim}}>×</button>
</div>
{choice.noResult?
<div style={{padding:'20px',textAlign:'center',color:C.red,fontSize:14}}>Aucun résultat trouvé. Vérifie l'orthographe ou ajoute le département (ex : "Angoulême 16").</div>
:
<div style={{overflowY:'auto',flex:1}}>
<div style={{fontSize:12,color:C.dim,marginBottom:8,fontStyle:'italic'}}>Clique sur le bon département pour valider</div>
{(choice.results||[]).map((r,i)=>{
const dept=getDept(r),deptName=getDeptName(r),city=getCity(r);
return(
<div key={i} onClick={()=>onPick(r)} style={{padding:'10px 12px',border:'2px solid '+C.border,borderRadius:8,marginBottom:8,cursor:'pointer',background:'#f8fafc',display:'flex',alignItems:'center',gap:12}} onMouseEnter={e=>{e.currentTarget.style.background='#e0f2fe';e.currentTarget.style.borderColor=C.accent}} onMouseLeave={e=>{e.currentTarget.style.background='#f8fafc';e.currentTarget.style.borderColor=C.border}}>
{dept&&<div style={{background:C.accent,color:'#fff',fontWeight:800,fontSize:18,padding:'8px 10px',borderRadius:8,minWidth:48,textAlign:'center'}}>{dept}</div>}
<div style={{flex:1,minWidth:0}}>
<div style={{fontSize:14,fontWeight:700,color:C.text}}>{city||r.display_name.split(',')[0]}{deptName?' — '+deptName:''}</div>
<div style={{fontSize:11,color:C.dim,marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.display_name}</div>
</div>
</div>
)})}
</div>
}
<div style={{textAlign:'center',marginTop:8}}><button onClick={onClose} style={btnStyle(C.dim)}>Annuler</button></div>
</div>
</div>);
};
const Fl=({label,children})=>(<div style={{marginBottom:12}}><label style={{display:'block',fontSize:13,fontWeight:600,color:C.dim,marginBottom:4}}>{label}</label>{children}</div>);
const inputStyle={width:'100%',padding:'8px 12px',border:'1px solid '+C.border,borderRadius:6,fontSize:14,outline:'none'};
const btnStyle=(color,full)=>({padding:'8px 16px',background:full?color:'transparent',color:full?'#fff':color,border:'2px solid '+color,borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14});
const Bg=({text,color,style:s})=>(<span style={{display:'inline-block',padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:(color||C.accent)+'18',color:color||C.accent,...s}}>{text}</span>);
const SentBg=()=>(<Bg text="Envoye" color={C.green}/>);
const EBtn=({onClick})=>(<button onClick={e=>{e.stopPropagation();onClick()}} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.dim}}>&#9998;</button>);
const CtBadge=({dateStr,label})=>{if(!dateStr)return null;const diff=Math.floor((new Date(dateStr)-new Date())/86400000);const color=diff<0?C.red:diff<30?C.orange:C.green;return(<Bg text={label+': '+dateStr} color={color}/>)};

const LoginScreen=({onLogin,data})=>{
const[id,setId]=useState('');const[pw,setPw]=useState('');const[err,setErr]=useState('');
const submit=()=>{if(id===(data.adminUser||'admin')&&pw===(data.adminPass||'admin')){onLogin('admin',null);return}const emp=(data.employees||[]).find(e=>e.login===id);if(emp&&(data.empPasswords||{})[emp.id]===pw){onLogin('employee',emp.id);return}setErr('Identifiant ou mot de passe incorrect')};
return(
<div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'linear-gradient(135deg,#004d3a,#008965)'}}>
<div style={{background:'#fff',borderRadius:16,padding:40,width:380,maxWidth:'90vw',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}}>
<div style={{textAlign:'center',marginBottom:24}}><img src="logo.png" alt="SONECO" style={{width:200,marginBottom:8}}/><h1 style={{fontSize:20,color:C.text}}>RoadManager</h1><p style={{color:C.dim,fontSize:14}}>Gestion de travaux routiers</p></div>
{err&&<div style={{background:'#fef2f2',color:C.red,padding:8,borderRadius:6,fontSize:13,marginBottom:12}}>{err}</div>}
<Fl label="Identifiant"><input style={inputStyle} value={id} onChange={e=>setId(e.target.value)} placeholder="admin"/></Fl>
<Fl label="Mot de passe"><input style={inputStyle} type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="********" onKeyDown={e=>e.key==='Enter'&&submit()}/></Fl>
<button onClick={submit} style={{...btnStyle(C.accent,true),width:'100%',padding:12,marginTop:8}}>Connexion</button>
</div></div>);};

// ======== MISSION FORM ========
const MissionForm=({data,save,job,onClose,selectedDate,selectedEmpId})=>{
const[empId,setEmpId]=useState(job?job.employeeId:selectedEmpId||'');
const[machId,setMachId]=useState(job?job.machineId:'');
const[clientId,setClientId]=useState(job?job.clientId:'');
const[newClient,setNewClient]=useState('');
const[agency,setAgency]=useState(job?job.agencyName||'':'');
const[siteMgr,setSiteMgr]=useState(job?job.siteManager||'':'');
const[siteMgrPh,setSiteMgrPh]=useState(job?job.siteManagerPhone||'':'');
const[location,setLocation]=useState(job?job.location||'':'');
const[gps,setGps]=useState(job?job.gps||'':'');
const[forfait,setForfait]=useState(job?job.forfaitType||'':'');
const[citOpt,setCitOpt]=useState(job?job.citOption||'Avec chauffeur':'Avec chauffeur');
const[price,setPrice]=useState(job?job.priceForfait||0:0);
const[isNight,setIsNight]=useState(job?!!job.isNight:false);
const[hasTransfer,setHasTransfer]=useState(job?!!job.hasTransfer:false);
const[transferPr,setTransferPr]=useState(job?job.transferPrice||0:0);
const[billStart,setBillStart]=useState(job?job.billingStart||'08:00':'08:00');
const[startFrom,setStartFrom]=useState(job?job.startFrom||'':'');
const[endAt,setEndAt]=useState(job?job.endAt||'':'');
const[fuelL,setFuelL]=useState(job?job.machineFuelL||0:0);
const[fuelDepot,setFuelDepot]=useState(job?job.machineFuelDepot||'':'');
const[addrRes,setAddrRes]=useState([]);
const[departOpts,setDepartOpts]=useState([]);
const[arriveeOpts,setArriveeOpts]=useState([]);
const[routeCalcing,setRouteCalcing]=useState(false);
const timer=useRef(null);
const routeTimer=useRef(null);
const dateStr=selectedDate||fmtDateISO(new Date());
const dayJobs=(data.jobs||[]).filter(j=>j.date===dateStr&&(!job||j.id!==job.id));
const usedM=dayJobs.filter(j=>j.employeeId!==empId).map(j=>j.machineId);
const emp=(data.employees||[]).find(e=>e.id===empId);
const machines=(data.machines||[]).filter(m=>!usedM.includes(m.id)||(job&&job.machineId===m.id)||(emp&&emp.machineId===m.id));
const client=clientId?(data.clients||[]).find(c=>c.id===clientId):null;
const mach=machId?(data.machines||[]).find(m=>m.id===machId):null;
useEffect(()=>{if(!machId&&emp&&emp.machineId)setMachId(emp.machineId)},[empId]);
useEffect(()=>{if(mach&&forfait){const p=getForfaitPrice(data,clientId,mach,forfait,citOpt,isNight);if(p)setPrice(p)}},[forfait,clientId,machId,citOpt,isNight]);
useEffect(()=>{if(hasTransfer&&mach){const t=getTransferPrice(data,clientId,mach,citOpt,isNight);if(t)setTransferPr(t)}},[hasTransfer,clientId,machId,citOpt,isNight]);
useEffect(()=>{if(client&&siteMgr){const s=(client.siteManagers||[]).find(x=>x.name===siteMgr);if(s)setSiteMgrPh(s.phone||'')}},[siteMgr,clientId]);
const doAddr=useCallback(q=>{if(timer.current)clearTimeout(timer.current);if(q.length<3){setAddrRes([]);return}timer.current=setTimeout(()=>{searchAddress(q).then(r=>setAddrRes(r||[]))},500)},[]);
// --- Route cards calculation ---
const calcAllRoutes=useCallback(async()=>{const co=parseCoords(gps);if(!co){setDepartOpts([]);setArriveeOpts([]);return}setRouteCalcing(true);const depOpts=[];const arrOpts=[];const empObj=(data.employees||[]).find(e=>e.id===empId);const empCo=empObj&&empObj._coords?parseCoords(typeof empObj._coords==='string'?empObj._coords:empObj._coords.join(',')):null;// Domicile
if(empCo){try{const rA=await osmRoute(empCo,co);const rR=await osmRoute(co,empCo);depOpts.push({id:'home',name:'Domicile',km:rA.km,min:+rA.min,hasCoords:true});arrOpts.push({id:'home',name:'Domicile',km:rR.km,min:+rR.min,hasCoords:true})}catch(e){depOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:true});arrOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:true})}}else{depOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:false});arrOpts.push({id:'home',name:'Domicile',km:0,min:0,hasCoords:false})}// Depots
for(const dep of(data.depots||[])){const dc=dep._coords?parseCoords(typeof dep._coords==='string'?dep._coords:dep._coords.join(',')):null;if(dc){try{const rA=await osmRoute(dc,co);const rR=await osmRoute(co,dc);depOpts.push({id:dep.id,name:dep.name,km:rA.km,min:+rA.min,hasCoords:true});arrOpts.push({id:dep.id,name:dep.name,km:rR.km,min:+rR.min,hasCoords:true})}catch(e){depOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:true});arrOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:true})}}else{depOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:false});arrOpts.push({id:dep.id,name:dep.name,km:0,min:0,hasCoords:false})}}setDepartOpts(depOpts);setArriveeOpts(arrOpts);setRouteCalcing(false)},[gps,empId,data.depots,data.employees]);
useEffect(()=>{if(routeTimer.current)clearTimeout(routeTimer.current);routeTimer.current=setTimeout(()=>{if(gps&&empId)calcAllRoutes()},500);return()=>{if(routeTimer.current)clearTimeout(routeTimer.current)}},[gps,empId,calcAllRoutes]);
const shortestDep=useMemo(()=>{const valid=departOpts.filter(o=>o.hasCoords&&o.km>0);return valid.length>0?valid.reduce((mn,o)=>o.km<mn.km?o:mn,valid[0]):null},[departOpts]);
const shortestArr=useMemo(()=>{const valid=arriveeOpts.filter(o=>o.hasCoords&&o.km>0);return valid.length>0?valid.reduce((mn,o)=>o.km<mn.km?o:mn,valid[0]):null},[arriveeOpts]);
const selDep=departOpts.find(o=>o.id===startFrom);
const selArr=arriveeOpts.find(o=>o.id===endAt);
const kmA=selDep?selDep.km:0;const minA=selDep?selDep.min:0;
const kmR=selArr?selArr.km:0;const minR=selArr?selArr.min:0;
const forfaits=mach&&mach.type==='Citerne'?['Demi-journee','Journee']:['2h','4h','6h','8h'];
const handleSave=()=>{let nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];let cId=clientId;if(newClient&&!clientId){const nc={id:uid(),name:newClient,forfaitType:'standard',agencies:[],siteManagers:[]};if(!nd.clients)nd.clients=[];nd.clients.push(nc);cId=nc.id}if(siteMgr&&cId){const cl=(nd.clients||[]).find(c=>c.id===cId);if(cl&&!(cl.siteManagers||[]).find(s=>s.name===siteMgr)){if(!cl.siteManagers)cl.siteManagers=[];cl.siteManagers.push({name:siteMgr,phone:siteMgrPh})}}const jb={id:job?job.id:uid(),date:dateStr,employeeId:empId,machineId:machId,clientId:cId,agencyName:agency,siteManager:siteMgr,siteManagerPhone:siteMgrPh,location,gps,forfaitType:forfait,citOption:mach&&mach.type==='Citerne'?citOpt:undefined,priceForfait:Number(price),isNight,hasTransfer,transferPrice:Number(transferPr),billingStart:billStart,startFrom,endAt,machineFuelL:Number(fuelL),machineFuelDepot:fuelDepot,kmAller:kmA,kmRetour:kmR,travelMinAller:minA,travelMinRetour:minR,distanceKm:kmA+kmR,travelMin:minA+minR,sent:job?job.sent:false};const idx=nd.jobs.findIndex(j=>j.id===jb.id);if(idx>=0)nd.jobs[idx]=jb;else nd.jobs.push(jb);save(nd);onClose()};
const selField=(label,val,setVal,opts,ph)=>(<Fl label={label}><select style={inputStyle} value={val} onChange={e=>setVal(e.target.value)}><option value="">{ph||'--'}</option>{opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select></Fl>);
const RouteCard=({opt,selected,isShortest,onClick})=>{const noGps=!opt.hasCoords;const noData=opt.hasCoords&&opt.km===0&&!parseCoords(gps);const isSel=selected;const isShort=!isSel&&isShortest;const bdr=isSel?'2px solid #008965':isShort?'2px solid #16a34a':noGps?'2px solid #e2e8f0':'2px solid '+C.border;const bg=isSel?'#00896508':isShort?'#16a34a08':noGps?'#f1f5f9':'transparent';const clr=isSel?'#008965':isShort?'#16a34a':noGps?C.muted:C.dim;return(<div onClick={noGps?undefined:onClick} style={{border:bdr,background:bg,borderRadius:8,padding:'8px 12px',cursor:noGps?'not-allowed':'pointer',textAlign:'center',minWidth:90,opacity:noGps?0.5:1,flex:'1 1 auto'}}><div style={{fontSize:13,fontWeight:500,color:clr}}>{opt.name}</div>{noGps?<div style={{fontSize:9,color:C.muted}}>Pas de GPS</div>:!parseCoords(gps)?<div style={{fontSize:16,fontWeight:500,color:clr}}>— km</div>:<React.Fragment><div style={{fontSize:16,fontWeight:700,color:clr}}>{opt.km} km</div><div style={{fontSize:9,color:clr}}>{fmtDuration(opt.min)}</div></React.Fragment>}</div>)};
const depName=startFrom==='home'?'Domicile':(data.depots||[]).find(d=>d.id===startFrom)?.name||'?';
const arrName=endAt==='home'?'Domicile':(data.depots||[]).find(d=>d.id===endAt)?.name||'?';
return(
<Mod title={job?'Modifier mission':'Nouvelle mission'} onClose={onClose} width={540}>
<Fl label="Client"><select style={inputStyle} value={clientId} onChange={e=>{setClientId(e.target.value);setNewClient('')}}><option value="">-- Choisir --</option>{(data.clients||[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{!clientId&&<input style={{...inputStyle,marginTop:4}} placeholder="Nouveau client" value={newClient} onChange={e=>setNewClient(e.target.value)}/>}</Fl>
{client&&(client.agencies||[]).length>0&&selField('Agence',agency,setAgency,(client.agencies||[]).map(a=>({v:a,l:a})))}
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Chef chantier"><input list="sm-dl" style={inputStyle} value={siteMgr} onChange={e=>setSiteMgr(e.target.value)}/><datalist id="sm-dl">{(client&&client.siteManagers||[]).map((s,i)=><option key={i} value={s.name}/>)}</datalist></Fl>
<Fl label="Tel chef"><input style={inputStyle} value={siteMgrPh} onChange={e=>setSiteMgrPh(e.target.value)}/></Fl>
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
{selField('Chauffeur',empId,setEmpId,(data.employees||[]).map(e=>({v:e.id,l:e.name})),'Choisir')}
{selField('Machine',machId,setMachId,machines.map(m=>({v:m.id,l:m.name+' ('+m.type+')'})),'Choisir')}
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Debut facturation"><input type="time" style={inputStyle} value={billStart} onChange={e=>setBillStart(e.target.value)}/></Fl>
<Fl label="Date"><input type="date" style={inputStyle} value={dateStr} disabled/></Fl>
</div>
<Fl label="Lieu du chantier"><input style={inputStyle} value={location} onChange={e=>{setLocation(e.target.value);doAddr(e.target.value)}}/>{addrRes.length>0&&<div style={{border:'1px solid '+C.border,borderRadius:6,maxHeight:120,overflow:'auto',background:'#fff'}}>{addrRes.map((r,i)=><div key={i} style={{padding:'4px 8px',cursor:'pointer',fontSize:12,borderBottom:'1px solid #f1f5f9'}} onClick={()=>{setLocation(r.display_name);setGps(r.lat+','+r.lon);setAddrRes([])}}>{r.display_name}</div>)}</div>}<input style={{...inputStyle,marginTop:4,fontSize:11}} value={gps} onChange={e=>setGps(e.target.value)} placeholder="GPS (lat,lon)"/></Fl>
<Fl label="Forfait"><div style={{display:'flex',gap:4,flexWrap:'wrap',alignItems:'center'}}>{forfaits.map(f=><button key={f} onClick={()=>setForfait(f)} style={{...btnStyle(FC[f]||C.accent,forfait===f),padding:'4px 10px',fontSize:12}}>{f}</button>)}<label style={{display:'flex',gap:4,fontSize:12,cursor:'pointer',marginLeft:8}}><input type="checkbox" checked={hasTransfer} onChange={e=>setHasTransfer(e.target.checked)}/>+Transfert</label></div></Fl>
{mach&&mach.type==='Citerne'&&<Fl label="Option citerne"><div style={{display:'flex',gap:8}}>{['Avec chauffeur','Sans chauffeur'].map(o=><label key={o} style={{display:'flex',gap:4,fontSize:13,cursor:'pointer'}}><input type="radio" name="citOpt" checked={citOpt===o} onChange={()=>setCitOpt(o)}/>{o}</label>)}</div></Fl>}
<label style={{display:'flex',gap:4,fontSize:13,cursor:'pointer',marginBottom:12}}><input type="checkbox" checked={isNight} onChange={e=>setIsNight(e.target.checked)}/>Nuit (+{data.nightPct||30}%)</label>
<Fl label={'Depart vers chantier'+(routeCalcing?' ⏳':'')}>
{departOpts.length>0?<div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{departOpts.map(o=><RouteCard key={o.id} opt={o} selected={startFrom===o.id} isShortest={shortestDep&&shortestDep.id===o.id} onClick={()=>setStartFrom(o.id)}/>)}</div>:<div style={{fontSize:12,color:C.muted}}>Selectionnez un chauffeur et renseignez le GPS du chantier</div>}
</Fl>
<Fl label={'Arrivee depuis chantier'+(routeCalcing?' ⏳':'')}>
{arriveeOpts.length>0?<div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{arriveeOpts.map(o=><RouteCard key={o.id} opt={o} selected={endAt===o.id} isShortest={shortestArr&&shortestArr.id===o.id} onClick={()=>setEndAt(o.id)}/>)}</div>:<div style={{fontSize:12,color:C.muted}}>Selectionnez un chauffeur et renseignez le GPS du chantier</div>}
</Fl>
{startFrom&&endAt&&(kmA>0||kmR>0)&&<div style={{background:'#00896508',border:'1px solid #00896520',borderRadius:8,padding:'8px 12px',marginBottom:12,fontSize:13}}>
<div style={{color:'#0891b2'}}>Aller : {depName} → Chantier = <b>{kmA}km</b> ({fmtDuration(minA)})</div>
<div style={{color:'#7c3aed'}}>Retour : Chantier → {arrName} = <b>{kmR}km</b> ({fmtDuration(minR)})</div>
<div style={{textAlign:'right',color:C.accent,fontWeight:700,marginTop:2}}>Total : {(kmA+kmR).toFixed(1)}km ({fmtDuration(minA+minR)})</div>
</div>}
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Prix forfait"><input type="number" style={inputStyle} value={price} onChange={e=>setPrice(e.target.value)}/></Fl>
{hasTransfer&&<Fl label="Prix transfert"><input type="number" style={inputStyle} value={transferPr} onChange={e=>setTransferPr(e.target.value)}/></Fl>}
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Conso machine (L)"><input type="number" style={inputStyle} value={fuelL} onChange={e=>setFuelL(e.target.value)}/></Fl>
{selField('Depot carburant',fuelDepot,setFuelDepot,(data.depots||[]).map(d=>({v:d.id,l:d.name})))}
</div>
<div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
<button onClick={onClose} style={btnStyle(C.dim)}>Annuler</button>
{job&&<button onClick={()=>{if(!confirm('Supprimer cette mission ?'))return;const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(j=>j.id!==job.id);save(nd);onClose()}} style={btnStyle(C.red)}>Supprimer</button>}
<button onClick={handleSave} style={btnStyle(C.accent,true)}>Enregistrer</button>
</div></Mod>);};

// ======== MISSION DETAIL ========
const MissionDetail=({data,save,job,onBack,onEdit})=>{
const client=(data.clients||[]).find(c=>c.id===job.clientId);
const mach=(data.machines||[]).find(m=>m.id===job.machineId);
const emp=(data.employees||[]).find(e=>e.id===job.employeeId);
const ft=getMachineFuelType(data,job.machineId);
const fp=getFuelPrice(data,ft,job.machineFuelDepot);
const truck=(data.trucks||[]).find(t=>emp&&t.id===emp.truckId);
const truckCons=truck?Number(truck.fuelPer100)||25:25;
const travelFuelL=((job.distanceKm||0)/100)*truckCons;
const travelFuelCost=travelFuelL*getFuelPrice(data,'gazole',job.startFrom!=='home'?job.startFrom:null);
const machineFuelCost=(job.machineFuelL||0)*fp;
const salaryCost=((job.travelMin||0)/60)*(emp?Number(emp.hourlySalary)||12:12);
const totalCost=salaryCost+travelFuelCost;
const toggleSent=()=>{const nd=JSON.parse(JSON.stringify(data));const j=nd.jobs.find(x=>x.id===job.id);if(j){j.sent=!j.sent;save(nd)}};
const row=(l,v,c)=>(<div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:4}}><span style={{color:C.dim}}>{l}</span><span style={{fontWeight:600,color:c||C.text}}>{v}</span></div>);
const card=(ch,st)=>(<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,...st}}>{ch}</div>);
return(
<div style={{maxWidth:700,margin:'0 auto'}}>
<button onClick={onBack} style={{...btnStyle(C.accent),marginBottom:12,fontSize:13}}>{'< Retour'}</button>
{card(<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
<div><div style={{fontSize:16,fontWeight:700}}>{client?client.name:'Client'} {job.agencyName?'- '+job.agencyName:''}</div>
<div style={{fontSize:20,fontWeight:800,color:C.accent}}>{fmtMoney((job.priceForfait||0)+(job.hasTransfer?job.transferPrice||0:0))}</div></div>
<div style={{display:'flex',gap:6,alignItems:'center'}}>{mach&&<Bg text={mach.name} color={MC[mach.type]||C.accent}/>}<button onClick={()=>onEdit(job)} style={btnStyle(C.accent)}>Modifier</button></div>
</div>
{job.siteManager&&<div style={{fontSize:13,marginBottom:4}}>Chef: {job.siteManager} {job.siteManagerPhone&&<a href={'tel:'+job.siteManagerPhone} style={{color:C.accent}}>{job.siteManagerPhone}</a>}</div>}
{job.location&&<div style={{fontSize:13,color:C.dim,marginBottom:4}}>{job.location}</div>}
{job.gps&&<div style={{marginBottom:4}}><a href={'https://www.google.com/maps?q='+job.gps} target="_blank" rel="noopener" style={{fontSize:12,color:C.accent}}>Voir sur Google Maps</a></div>}
<div style={{fontSize:13,color:C.dim}}>Debut: {job.billingStart} | Forfait: {job.forfaitType} {job.hasTransfer?'+T':''} | {(job.distanceKm||0).toFixed(1)} km</div>
</div>)}
{(job.kmAller>0||job.kmRetour>0)&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginTop:10}}>
{card(<div><div style={{fontSize:12,fontWeight:700,color:C.cyan,marginBottom:6}}>Aller</div>{row('Distance',(job.kmAller||0).toFixed(1)+' km')}{row('Duree',fmtDuration(job.travelMinAller||0))}</div>,{borderTop:'3px solid '+C.cyan})}
{card(<div><div style={{fontSize:12,fontWeight:700,color:'#8b5cf6',marginBottom:6}}>Retour</div>{row('Distance',(job.kmRetour||0).toFixed(1)+' km')}{row('Duree',fmtDuration(job.travelMinRetour||0))}</div>,{borderTop:'3px solid #8b5cf6'})}
</div>}
{job.hasTransfer&&card(<div><div style={{fontSize:12,fontWeight:700,color:C.orange,marginBottom:8}}>Cout transfert</div>{row('Salaire chauffeur',fmtMoney(salaryCost))}{row('Carburant',fmtMoney(travelFuelCost))}{row('Cout total',fmtMoney(totalCost),C.red)}{row('Facture',fmtMoney(job.transferPrice),C.accent)}{row('Marge',fmtMoney(job.transferPrice-totalCost),(job.transferPrice-totalCost)>=0?C.green:C.red)}</div>,{borderTop:'3px solid '+C.orange,marginTop:10})}
{card(<div><div style={{fontSize:12,fontWeight:700,color:C.dim,marginBottom:8}}>Carburant</div>{row('Trajet',travelFuelL.toFixed(1)+' L | '+fmtMoney(travelFuelCost)+' | '+(ft==='gazole'?'Gazole':'GNR'))}{job.machineFuelL>0&&row('Machine chantier',job.machineFuelL+' L | '+fmtMoney(machineFuelCost)+' | '+(ft==='gazole'?'Gazole':'GNR'))}</div>,{marginTop:10})}
{(()=>{const te=(data.timeEntries||[]).filter(t=>t.empId===job.employeeId&&t.date===job.date);const mainTE=te.find(t=>t.startTime&&t.endTime);const pMinDetail=mainTE?(mainTE.pauseMin||0):0;const theo=calcTheoreticalTimes(job,data,pMinDetail);if(!theo)return null;const tol=theo.tolerance;const hourly=emp?Number(emp.hourlySalary)||0:0;let deltaStartTxt='--',deltaEndTxt='--',overtimeMinE=0,overtimeMinD=0;if(mainTE&&mainTE.startTime){const[ash,asm]=mainTE.startTime.split(':').map(Number);const dS=(ash*60+asm)-theo.theoStartMin;deltaStartTxt=dS>0?'+'+dS+'min (retard)':dS<0?dS+'min (avance)':'0min';if(dS<0)overtimeMinE=Math.abs(dS)}if(mainTE&&mainTE.endTime){const[aeh,aem]=mainTE.endTime.split(':').map(Number);const dE=(aeh*60+aem)-theo.theoEndMin;deltaEndTxt=dE>0?'+'+dE+'min (depassement)':dE<0?dE+'min (avance)':'0min';if(dE>0)overtimeMinD=dE}const overtimeMin=overtimeMinE+overtimeMinD;const overtimeCost=overtimeMin*(hourly/60);return card(
<div>
<div style={{fontSize:12,fontWeight:700,color:C.orange,marginBottom:8}}>Analyse des heures</div>
{row('Theo. embauche',theo.theoStart)}
{mainTE&&mainTE.startTime&&row('Reelle embauche',mainTE.startTime)}
{row('Delta embauche',deltaStartTxt,deltaStartTxt.includes('retard')?C.red:deltaStartTxt.includes('avance')?C.orange:C.green)}
{row('Theo. debauche',theo.theoEnd)}
{mainTE&&mainTE.endTime&&row('Reelle debauche',mainTE.endTime)}
{row('Delta debauche',deltaEndTxt,deltaEndTxt.includes('depassement')?C.red:C.green)}
{overtimeMinE>0&&row('Surcout embauche tot (+'+overtimeMinE+'min)',fmtMoney(overtimeMinE*(hourly/60)),C.orange)}
{overtimeMinD>0&&row('Surcout debauche tard (+'+overtimeMinD+'min)',fmtMoney(overtimeMinD*(hourly/60)),C.red)}
{(overtimeMinE+overtimeMinD)>0&&row('Surcout total ('+(overtimeMinE+overtimeMinD)+'min)',fmtMoney(overtimeCost),C.red)}
</div>,{borderTop:'3px solid '+C.orange,marginTop:10})})()}
<div style={{marginTop:12,textAlign:'center'}}><button onClick={toggleSent} style={btnStyle(job.sent?C.green:C.accent,true)}>{job.sent?'Envoye':'Envoyer'}</button></div>
</div>);};

// ======== WIRTGEN DETECTION (algo simple basé sur "On" moteur + zone GPS) ========
// pts = [{iso,min,hhmm,lat,lon}], hopEvts = [{iso,min,hhmm}] triés par min
//
// Algorithme :
// 1. Position GPS de chaque "On" moteur → définit la zone chantier (rayon 1km)
// 2. siteArrival/siteDeparture = 1er/dernier pt GPS dans la zone
// 3. depotDepart/depotArrival = pt GPS hors zone (avant/après)
// 4. workStart = 1er "On" après siteArrival (fallback siteArrival+5min si écart >4h)
// 5. workEnd = dernier pt GPS dans la zone
// opTimeBuckets (optionnel) : tranches horaires avec temps fraisage actif (depuis Measurements.csv)
//   → utilisé pour valider qu'un "On" moteur correspond à du vrai fraisage
const detectWirtgenTimeline=(pts,hopEvts,opTimeBuckets)=>{
if(!pts||!pts.length)return{depotDepart:null,depotArrival:null,sites:[]};
const lastPt=pts[pts.length-1];
if(!hopEvts||!hopEvts.length){
  return{depotDepart:pts[0].hhmm,depotArrival:lastPt.hhmm,sites:[]};
}
// 1. Position GPS de chaque "On" (point GPS le + proche en temps)
const hopPosAll=hopEvts.map(h=>{
  let best=pts[0],bestDt=Math.abs(pts[0].min-h.min);
  for(const p of pts){const dt=Math.abs(p.min-h.min);if(dt<bestDt){bestDt=dt;best=p}}
  return{...h,lat:best.lat,lon:best.lon};
});
// Détecte si pts[0] est un dépôt (la machine n'y reste pas) ou un chantier (elle y reste).
// Si dépôt, on filtre les "On" qui sont au dépôt (démarrage moteur avant le trajet).
const PTS0_DEPOT_THRESH_MIN=30;
let lastVicinityIdx=0;
for(let i=1;i<pts.length;i++){
  if(haversine([pts[i].lat,pts[i].lon],[pts[0].lat,pts[0].lon])<=1.0)lastVicinityIdx=i;
  else break;
}
const pts0IsDepot=(pts[lastVicinityIdx].min-pts[0].min)<PTS0_DEPOT_THRESH_MIN;
let hopPosClean=hopPosAll;
if(pts0IsDepot){
  const filtered=hopPosAll.filter(h=>haversine([h.lat,h.lon],[pts[0].lat,pts[0].lon])>1.0);
  if(filtered.length>0)hopPosClean=filtered; // garde si au moins 1 hop reste
}
// Clusterise les "On" par position (rayon 5km) et garde le cluster principal.
// Écarte les "On" isolés (démarrage auxiliaire pendant transit, etc.) qui pollueraient la zone.
const CLUSTER_KM=5.0;const ZONE_KM=1.0;const STATIONARY_KM=0.2;
const clusters=[];
for(const h of hopPosClean){
  const c=clusters.find(cl=>cl.hops.some(ch=>haversine([ch.lat,ch.lon],[h.lat,h.lon])<=CLUSTER_KM));
  if(c)c.hops.push(h);else clusters.push({hops:[h]});
}
// Sélection : garde TOUS les clusters significatifs (>= 2 pts GPS dans vicinité).
// Permet la détection multi-chantiers le même jour (ex: chantier matin + chantier nuit).
clusters.forEach(c=>{c.gpsDwell=pts.filter(p=>c.hops.some(h=>haversine([p.lat,p.lon],[h.lat,h.lon])<=ZONE_KM)).length});
// Filtre les clusters d'1 seul hop qui sont près de pts[0] (= démarrage moteur au dépôt, pas vrai fraisage).
// SAUF si tous les hops du fichier sont près de pts[0] (= machine à un chantier où elle a passé la nuit).
const allNearPts0=hopPosAll.every(h=>haversine([h.lat,h.lon],[pts[0].lat,pts[0].lon])<=1.5);
let sigClusters=clusters.filter(c=>{
  if(c.gpsDwell<2)return false;
  if(c.hops.length===1&&!allNearPts0){
    const dToPts0=haversine([c.hops[0].lat,c.hops[0].lon],[pts[0].lat,pts[0].lon]);
    if(dToPts0<=1.5)return false;
  }
  return true;
});
if(!sigClusters.length){clusters.sort((a,b)=>(b.hops.length-a.hops.length)||(b.gpsDwell-a.gpsDwell));sigClusters=[clusters[0]]}
sigClusters.sort((a,b)=>a.hops[0].min-b.hops[0].min); // chronologique
// Helpers communs
const toMin=t=>{const[h,m]=t.split(':').map(Number);return h*60+m};
const minToHHMM=mn=>{const mm=((mn%1440)+1440)%1440;return String(Math.floor(mm/60)).padStart(2,'0')+':'+String(mm%60).padStart(2,'0')};
const MIN_OP_H=0.05;
const hopHasOpTime=h=>{if(!opTimeBuckets||!opTimeBuckets.length)return null;const b=opTimeBuckets.find(b=>h.min>=b.startMin&&h.min<b.endMin);return b?b.opH>=MIN_OP_H:false};
// Pour chaque cluster : compute ses 6 événements (incluant depotDepart/depotArrival per-site)
const sites=sigClusters.map((cluster,cIdx)=>{
  const inClZone=p=>cluster.hops.some(h=>haversine([p.lat,p.lon],[h.lat,h.lon])<=ZONE_KM);
  let firstIdx=-1,lastIdx=-1;
  for(let i=0;i<pts.length;i++){if(inClZone(pts[i])){if(firstIdx===-1)firstIdx=i;lastIdx=i}}
  if(firstIdx===-1)return null;
  // Borne basse pour recherche dépôt = sortie du cluster précédent (évite de chevaucher 2 sites)
  const prevCluster=cIdx>0?sigClusters[cIdx-1]:null;
  let prevExitIdx=-1;
  if(prevCluster){
    const prevInZone=p=>prevCluster.hops.some(h=>haversine([p.lat,p.lon],[h.lat,h.lon])<=ZONE_KM);
    for(let i=0;i<firstIdx;i++)if(prevInZone(pts[i]))prevExitIdx=i;
  }
  // Borne haute = entrée du cluster suivant (idem)
  const nextCluster=cIdx<sigClusters.length-1?sigClusters[cIdx+1]:null;
  let nextEntryIdx=pts.length;
  if(nextCluster){
    const nextInZone=p=>nextCluster.hops.some(h=>haversine([p.lat,p.lon],[h.lat,h.lon])<=ZONE_KM);
    for(let i=lastIdx+1;i<pts.length;i++)if(nextInZone(pts[i])){nextEntryIdx=i;break}
  }
  const startedInZone=firstIdx===0;
  const endedInZone=lastIdx===pts.length-1;
  // depotDepart = dernier pt à proximité de pts[0] entre prevExitIdx et firstIdx (inclus)
  let depotDepart=null;
  if(!startedInZone){
    let lastDepotIdx=Math.max(0,prevExitIdx+1);
    for(let i=Math.max(1,prevExitIdx+1);i<firstIdx;i++){
      if(haversine([pts[i].lat,pts[i].lon],[pts[0].lat,pts[0].lon])<=1.0)lastDepotIdx=i;
    }
    depotDepart=pts[lastDepotIdx].hhmm;
  }
  // siteArrival : par défaut = 1er pt GPS en zone. Mais si le 1er hop "On" est très proche en temps
  // de ce pt (< 3 min), c'est probablement que la machine est arrivée juste avant le sampling GPS.
  // Dans ce cas on interpole à mi-chemin entre dernier pt en transit et 1er pt en zone.
  const firstHopAbsMin=cluster.hops.length?cluster.hops[0].min:null;
  let siteArrival=null;
  if(!startedInZone){
    const firstZonePtMin=pts[firstIdx].min;
    if(firstHopAbsMin!=null&&Math.abs(firstHopAbsMin-firstZonePtMin)<3&&firstIdx>0){
      const midMin=Math.round((pts[firstIdx-1].min+firstZonePtMin)/2);
      siteArrival=minToHHMM(midMin);
    }else siteArrival=pts[firstIdx].hhmm;
  }
  // siteDeparture = mi-chemin entre dernier pt en zone et 1er pt hors zone (= meilleure estimation
  // siteDeparture = dernier pt GPS dans la zone (= dernière fois où on est sûr que la machine était au chantier)
  let siteDeparture=endedInZone?null:pts[lastIdx].hhmm;
  // depotArrival = 1er pt à proximité de pts[0] APRÈS lastIdx (et avant nextEntryIdx)
  // OU début phase stationnaire en fin de fenêtre si pas de retour dépôt strict
  let depotArrival=null;
  if(!endedInZone&&nextEntryIdx>lastIdx+1){
    for(let i=lastIdx+1;i<nextEntryIdx;i++){
      if(haversine([pts[i].lat,pts[i].lon],[pts[0].lat,pts[0].lon])<=1.0){depotArrival=pts[i].hhmm;break}
    }
    if(!depotArrival&&cIdx===sigClusters.length-1){
      // Dernier site : fallback sur dernière phase stationnaire
      let stationaryStartIdx=pts.length-1;
      for(let i=pts.length-2;i>lastIdx;i--){
        if(haversine([pts[i].lat,pts[i].lon],[lastPt.lat,lastPt.lon])<STATIONARY_KM)stationaryStartIdx=i;
        else break;
      }
      depotArrival=pts[stationaryStartIdx].hhmm;
    }
  }
  // (Note: siteDeparture est déjà interpolé à mi-chemin ci-dessus, donc plus besoin de fallback ici)
  // workStart pour CE cluster
  const clHops=cluster.hops;
  let workStart,workStartAbsMin;
  if(siteArrival){
    const siteArrMin=pts[firstIdx].min;
    const hopAfterArr=clHops.find(h=>h.min>=siteArrMin);
    const hopJustBefore=clHops.slice().reverse().find(h=>h.min<siteArrMin&&siteArrMin-h.min<=10&&hopHasOpTime(h)===true);
    if(hopJustBefore){workStart=hopJustBefore.hhmm;workStartAbsMin=hopJustBefore.min}
    else if(hopAfterArr&&hopAfterArr.min-siteArrMin<=240){workStart=hopAfterArr.hhmm;workStartAbsMin=hopAfterArr.min}
    else{workStartAbsMin=siteArrMin+5;workStart=minToHHMM(workStartAbsMin)}
  }else{
    if(clHops.length){workStart=clHops[0].hhmm;workStartAbsMin=clHops[0].min}
    else{workStart=pts[firstIdx].hhmm;workStartAbsMin=pts[firstIdx].min}
  }
  // workEnd : on prend le MAX des candidats pour ne pas s'arrêter trop tôt :
  //   - dernier hop "On" moteur en zone (= dernière coupure-redémarrage avant départ chantier)
  //   - OpTime end estimé (millingEndEst) si bucket horaire
  // Plafonné par le dernier pt GPS en zone (la machine ne peut pas fraiser hors zone).
  const lastPtInZoneMin=pts[lastIdx].min;
  let workEndAbsMin=workStartAbsMin;
  const lastHopInZone=cluster.hops[cluster.hops.length-1];
  if(lastHopInZone&&lastHopInZone.min<=lastPtInZoneMin)workEndAbsMin=Math.max(workEndAbsMin,lastHopInZone.min);
  if(opTimeBuckets&&opTimeBuckets.length){
    const sigBuckets=opTimeBuckets.filter(b=>b.opH>=MIN_OP_H&&(b.endMin-b.startMin)<=90);
    const clStart=pts[firstIdx].min;
    const relevant=sigBuckets.filter(b=>b.startMin>=clStart-60&&b.endMin<=lastPtInZoneMin+60);
    if(relevant.length){
      const lastSig=relevant[relevant.length-1];
      const millingEndEst=lastSig.startMin+Math.round(lastSig.opH*60);
      if(millingEndEst<=lastPtInZoneMin)workEndAbsMin=Math.max(workEndAbsMin,millingEndEst);
    }
  }
  // Si aucun candidat trouvé, utilise le dernier pt GPS en zone par défaut
  if(workEndAbsMin<=workStartAbsMin)workEndAbsMin=lastPtInZoneMin;
  workEndAbsMin=Math.min(workEndAbsMin,lastPtInZoneMin);
  const workEndPt=pts.find(p=>p.min===workEndAbsMin);
  let workEnd=workEndPt?workEndPt.hhmm:minToHHMM(workEndAbsMin);
  if(workEndAbsMin<workStartAbsMin)workEnd=workStart;
  // Centroïde du chantier = moyenne des positions des "On" moteur du cluster
  const centroidLat=cluster.hops.reduce((s,h)=>s+h.lat,0)/cluster.hops.length;
  const centroidLon=cluster.hops.reduce((s,h)=>s+h.lon,0)/cluster.hops.length;
  // Détection des arrêts intermédiaires (>=30 min, hors dépôt et hors zone chantier) entre dépôt et chantier
  const findPauses=(sIdx,eIdx)=>{
    const result=[];
    let pStart=-1;
    const isPause=p=>{
      const nearDepot=haversine([p.lat,p.lon],[pts[0].lat,pts[0].lon])<=1.0;
      const nearCluster=cluster.hops.some(h=>haversine([p.lat,p.lon],[h.lat,h.lon])<=ZONE_KM);
      return!nearDepot&&!nearCluster;
    };
    for(let i=sIdx;i<=eIdx;i++){
      const p=pts[i];
      if(!isPause(p)){
        if(pStart!==-1){
          const pEnd=i-1;const dur=pts[pEnd].min-pts[pStart].min;
          if(dur>=30){const mid=Math.floor((pStart+pEnd)/2);result.push({startHhmm:pts[pStart].hhmm,endHhmm:pts[pEnd].hhmm,lat:pts[mid].lat,lon:pts[mid].lon,durationMin:dur})}
          pStart=-1;
        }continue;
      }
      if(pStart===-1)pStart=i;
      else{
        const ref=pts[pStart];
        if(haversine([p.lat,p.lon],[ref.lat,ref.lon])>0.5){
          const pEnd=i-1;const dur=pts[pEnd].min-pts[pStart].min;
          if(dur>=30){const mid=Math.floor((pStart+pEnd)/2);result.push({startHhmm:pts[pStart].hhmm,endHhmm:pts[pEnd].hhmm,lat:pts[mid].lat,lon:pts[mid].lon,durationMin:dur})}
          pStart=i;
        }
      }
    }
    if(pStart!==-1&&pStart<eIdx){
      const dur=pts[eIdx].min-pts[pStart].min;
      if(dur>=30){const mid=Math.floor((pStart+eIdx)/2);result.push({startHhmm:pts[pStart].hhmm,endHhmm:pts[eIdx].hhmm,lat:pts[mid].lat,lon:pts[mid].lon,durationMin:dur})}
    }
    return result;
  };
  const outboundPauses=!startedInZone?findPauses(Math.max(prevExitIdx+1,0),firstIdx-1):[];
  const inboundPauses=!endedInZone?findPauses(lastIdx+1,Math.min(nextEntryIdx-1,pts.length-1)):[];
  return{siteArrival,workStart,workEnd,siteDeparture,depotDepart,depotArrival,centroid:{lat:centroidLat,lon:centroidLon},outboundPauses,inboundPauses};
}).filter(s=>s!==null);
// Global depotDepart/depotArrival = 1er site / dernier site (pour rétrocompat affichage)
const globalDepotDepart=sites.length?sites[0].depotDepart:null;
const globalDepotArrival=sites.length?sites[sites.length-1].depotArrival:null;
return{depotDepart:globalDepotDepart,depotArrival:globalDepotArrival,sites};
};
// Re-applique la détection sur un rapport stocké si données brutes présentes (migre les anciens formats)
// Si pas de rawPts, applique au moins la contrainte workStart > siteArrival (filet de sécurité legacy)
const recomputeWirtgenReport=(mr)=>{
if(!mr)return mr;
if(mr.rawPts&&mr.rawPts.length){
  const t=detectWirtgenTimeline(mr.rawPts,mr.rawHop||[],mr.opTimeBuckets||[]);
  return{...mr,depotDepart:t.depotDepart,depotArrival:t.depotArrival,sites:t.sites};
}
const toMinL=t=>{if(!t)return 0;const[h,m]=t.split(':').map(Number);return h*60+m};
const minToHHMML=mn=>String(Math.floor(mn/60)).padStart(2,'0')+':'+String(mn%60).padStart(2,'0');
const fixedSites=(mr.sites||[]).map(s=>{
  if(s&&s.workStart&&s.siteArrival&&toMinL(s.workStart)<=toMinL(s.siteArrival)){
    return{...s,workStart:minToHHMML(toMinL(s.siteArrival)+5)};
  }
  return s;
});
return{...mr,sites:fixedSites};
};
// ======== WIRTGEN ZIP PARSER ========
const parseWirtgenZip=async(file,targetDate=null)=>{
if(!window.JSZip)return null;
try{
const zip=await new window.JSZip().loadAsync(file);
const parseCSV=text=>{
const lines=text.trim().split(/\r?\n/);if(!lines.length)return[];
const hdrs=[];let cur='',inQ=false;
for(const c of lines[0]){if(c==='"'){inQ=!inQ}else if(c===','&&!inQ){hdrs.push(cur.trim());cur=''}else{cur+=c}}hdrs.push(cur.trim());
return lines.slice(1).map(line=>{const vals=[];let vc='',vQ=false;for(const c of line){if(c==='"'){vQ=!vQ}else if(c===','&&!vQ){vals.push(vc.trim());vc=''}else{vc+=c}}vals.push(vc.trim());const obj={};hdrs.forEach((h,i)=>{obj[h]=(vals[i]||'').trim()});return obj});
};
const parseWT=(dateStr,timeStr)=>{const months={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};const p=dateStr.replace(/,/g,'').split(' ');const mon=months[p[0]]??0,day=parseInt(p[1]),year=parseInt(p[2]);const[tp,ap]=timeStr.split(' ');let[h,m]=tp.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return{iso:year+'-'+pad2(mon+1)+'-'+pad2(day),min:h*60+m,hhmm:pad2(h)+':'+pad2(m)}};
let locText=null,measText=null,ehText=null,hopText=null;
for(const[,entry]of Object.entries(zip.files)){if(entry.dir)continue;const n=entry.name;if(/Location/i.test(n)&&n.endsWith('.csv'))locText=await entry.async('text');else if(/Measurements/i.test(n)&&n.endsWith('.csv'))measText=await entry.async('text');else if(/EngineHours/i.test(n)&&n.endsWith('.csv'))ehText=await entry.async('text');else if(/HoursOfOperation/i.test(n)&&n.endsWith('.csv'))hopText=await entry.async('text')}
if(!locText)return null;
const locRows=parseCSV(locText);if(!locRows.length)return null;
const machineName=locRows[0].Nickname||'';const serial=locRows[0]['Machine Serial Number']||'';
const allPts=locRows.map(r=>{const dt=parseWT(r.Date,r.Time);return{...dt,lat:parseFloat(r.Latitude),lon:parseFloat(r.Longitude)}}).sort((a,b)=>a.iso<b.iso?-1:a.iso>b.iso?1:a.min-b.min);
const allHops=hopText?parseCSV(hopText).filter(r=>r.Status==='On').map(r=>parseWT(r.Date,r.Time)).sort((a,b)=>a.iso<b.iso?-1:a.iso>b.iso?1:a.min-b.min):[];
let pts,hopEvts;
if(targetDate){
  pts=allPts.filter(p=>p.iso===targetDate);
  hopEvts=allHops.filter(h=>h.iso===targetDate);
  // EXTENSION CHANTIER DE NUIT : si le dernier pt du jour est loin du 1er pt (machine n'est pas rentrée),
  // on inclut les pts du JOUR SUIVANT jusqu'à ce que la machine revienne au dépôt (vicinité du 1er pt).
  if(pts.length){
    const firstPt=pts[0],lastPt=pts[pts.length-1];
    if(haversine([lastPt.lat,lastPt.lon],[firstPt.lat,firstPt.lon])>1.0){
      // Calcule jour suivant en ISO
      const d=new Date(targetDate+'T00:00:00');d.setDate(d.getDate()+1);
      const nextDay=d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
      const nextDayPts=allPts.filter(p=>p.iso===nextDay);
      // Inclure jusqu'à 2 pts consécutifs dans la vicinité du dépôt (= retour effectif)
      let cutoffIdx=0,consecAtDepot=0;
      for(let i=0;i<nextDayPts.length;i++){
        const dist=haversine([nextDayPts[i].lat,nextDayPts[i].lon],[firstPt.lat,firstPt.lon]);
        if(dist<=1.0){consecAtDepot++;if(consecAtDepot>=2){cutoffIdx=i+1;break}}
        else consecAtDepot=0;
      }
      if(cutoffIdx>0){
        // Décale les min de +24h pour que les heures soient continues (pas de wrap à minuit)
        const ext=nextDayPts.slice(0,cutoffIdx).map(p=>({...p,min:p.min+1440}));
        pts=[...pts,...ext];
        const maxMin=pts[pts.length-1].min;
        const extHops=allHops.filter(h=>h.iso===nextDay).map(h=>({...h,min:h.min+1440})).filter(h=>h.min<=maxMin);
        hopEvts=[...hopEvts,...extHops];
      }
    }
  }
}else{pts=allPts;hopEvts=allHops}
if(!pts.length)return null;
let fuelL=0,waterMin=999,opH=0;
let opTimeBuckets=[]; // [{startMin, endMin, opH, powerPct?, fuelL?, speedKmh?, fuelRateLh?, pressureBar?}] tranches horaires LOCAL
const powerByHour={};const fuelByHour={};const speedByHour={};const fuelRateByHour={};const pressureByHour={};
// Measurements : filtrer par "Start Date" pour ne garder que le jour cible
if(measText){
  const mr=parseCSV(measText).filter(r=>!targetDate||parseWT(r['Start Date']||r.Date,'12:00 AM').iso===targetDate);
  // Wirtgen stocke en UTC. France = UTC+2 (CEST avr-oct) ou UTC+1 (CET).
  const offsetH=(()=>{const m=parseInt((targetDate||(mr[0]&&parseWT(mr[0]['Start Date'],mr[0]['Start Time']).iso)||'2026-06-01').split('-')[1]);return(m>=4&&m<=10)?2:1})();
  mr.forEach(r=>{
    const v=parseFloat(r.Value);if(isNaN(v))return;
    const cat=r.Category||'';
    if(cat==='Fuel Used'){
      fuelL+=v;
      const start=parseWT(r['Start Date'],r['Start Time']);
      fuelByHour[start.min+offsetH*60]=v;
    }
    if(cat==='Operation Time'){
      opH+=v;
      const start=parseWT(r['Start Date'],r['Start Time']);
      const end=parseWT(r['End Date'],r['End Time']);
      opTimeBuckets.push({startMin:start.min+offsetH*60,endMin:end.min+offsetH*60,opH:v});
    }
    if(cat==='Engine Power Percentage'){
      const start=parseWT(r['Start Date'],r['Start Time']);
      powerByHour[start.min+offsetH*60]=v;
    }
    if(cat==='Average Vehicle Speed'){
      const start=parseWT(r['Start Date'],r['Start Time']);
      speedByHour[start.min+offsetH*60]=v;
    }
    if(cat==='Fuel consumption rate'){
      const start=parseWT(r['Start Date'],r['Start Time']);
      fuelRateByHour[start.min+offsetH*60]=v;
    }
    if(cat==='Average Driving System Pressure'){
      const start=parseWT(r['Start Date'],r['Start Time']);
      pressureByHour[start.min+offsetH*60]=v;
    }
    if(cat==='Water Tank Level'||cat==='Water Tank')waterMin=Math.min(waterMin,v);
  });
  opTimeBuckets.sort((a,b)=>a.startMin-b.startMin);
  // Enrichit chaque bucket avec power %, fuel L, vitesse km/h, conso L/h, pression bar
  opTimeBuckets.forEach(b=>{
    if(powerByHour[b.startMin]!==undefined)b.powerPct=Math.round(powerByHour[b.startMin]);
    if(fuelByHour[b.startMin]!==undefined)b.fuelL=Math.round(fuelByHour[b.startMin]);
    if(speedByHour[b.startMin]!==undefined)b.speedKmh=speedByHour[b.startMin];
    if(fuelRateByHour[b.startMin]!==undefined)b.fuelRateLh=fuelRateByHour[b.startMin];
    if(pressureByHour[b.startMin]!==undefined)b.pressureBar=pressureByHour[b.startMin];
  });
}
const {depotDepart,depotArrival,sites}=detectWirtgenTimeline(pts,hopEvts,opTimeBuckets);
let ehStart=0,ehEnd=0;
// EngineHours : filtrer par date
if(ehText){const er=parseCSV(ehText).filter(r=>!targetDate||parseWT(r.Date,r.Time).iso===targetDate);const hs=er.map(r=>parseFloat(r.Hours)).filter(v=>!isNaN(v));if(hs.length){ehStart=Math.min(...hs);ehEnd=Math.max(...hs)}}
const reportDate=targetDate||pts[0].iso;
return{id:uid(),machineName,serial,date:reportDate,depotDepart,depotArrival,sites,fuelL:Math.round(fuelL),waterMin:waterMin<999?Math.round(waterMin*10)/10:null,opH:Math.round(opH*10)/10,ehStart,ehEnd,rawPts:pts.map(p=>({iso:p.iso,min:p.min,hhmm:p.hhmm,lat:p.lat,lon:p.lon})),rawHop:hopEvts.map(h=>({iso:h.iso,min:h.min,hhmm:h.hhmm})),opTimeBuckets};
}catch(e){console.error('Wirtgen ZIP parse error',e);return null}
};
// ======== PLANNING PAGE ========
const DEPOT_ACTIVITIES=['Rangement / nettoyage','Mecanique / entretien','Attente pieces','Formation','Administratif','Autre'];
const PlanningPage=({data,save,sbHidden,setSbHidden})=>{
const[selDate,setSelDate]=useState(fmtDateISO(new Date()));
const[showJdImport,setShowJdImport]=useState(false);
const[jdImportRows,setJdImportRows]=useState([]);
const[jdImportStatus,setJdImportStatus]=useState('');
const[jdImporting,setJdImporting]=useState(false);
const normJd=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');
const jdReports=useMemo(()=>(data.jdReports||[]).filter(r=>r.report_date===selDate),[data.jdReports,selDate]);
const handleJdFile=async(file)=>{if(!file)return;setJdImportStatus('Lecture...');setJdImportRows([]);const appMachines=data.machines||[];const reader=new FileReader();reader.onload=(ev)=>{try{const wb=window.XLSX.read(ev.target.result,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];const rows=window.XLSX.utils.sheet_to_json(ws,{header:1,defval:null});if(rows.length<2){setJdImportStatus('Fichier vide ou invalide');return;}const parsed=[];for(let i=1;i<rows.length;i++){const r=rows[i];const rawName=String(r[0]||'').trim();if(!rawName)continue;const normName=normJd(rawName);const matchedMachine=appMachines.find(m=>normJd(m.name)===normName||(m.jdId&&normJd(m.jdId)===normName));const matched=!!matchedMachine;const dateStr=String(r[6]||'').split(' ')[0];const dp=dateStr.split('/');const reportDate=dp.length===3?dp[2]+'-'+dp[1].padStart(2,'0')+'-'+dp[0].padStart(2,'0'):'';const workingH=r[10]!=null?+Number(r[10]).toFixed(2):null;const idleH=r[11]!=null?+Number(r[11]).toFixed(2):null;const motorH=r[8]!=null?+Number(r[8]).toFixed(2):null;const transportH=(motorH!=null&&workingH!=null&&idleH!=null)?+Math.max(0,motorH-workingH-idleH).toFixed(2):null;const totalFuel=r[12]!=null?+Number(r[12]).toFixed(0):null;const workingFuel=r[15]!=null?+Number(r[15]).toFixed(0):null;const idleFuel=r[16]!=null?+Number(r[16]).toFixed(0):null;parsed.push({rawName,jdId:normName,matched,reportDate,workingH,idleH,transportH,totalFuel,workingFuel,idleFuel})}setJdImportRows(parsed);setJdImportStatus('');}catch(err){setJdImportStatus('Erreur: '+err.message);}};reader.readAsArrayBuffer(file);};
const doJdImport=()=>{const valid=jdImportRows.filter(r=>r.matched&&r.reportDate);if(!valid.length){alert('Aucune machine reconnue');return;}setJdImporting(true);setJdImportStatus('Import...');const records=valid.map(r=>({jd_id:r.jdId,report_date:r.reportDate,working_h:r.workingH,idle_h:r.idleH,transport_h:r.transportH,total_fuel_l:r.totalFuel,working_fuel_l:r.workingFuel,idle_fuel_l:r.idleFuel}));const nd=JSON.parse(JSON.stringify(data));if(!nd.jdReports)nd.jdReports=[];const importDates=[...new Set(records.map(r=>r.report_date))];const importIds=[...new Set(records.map(r=>r.jd_id))];nd.jdReports=nd.jdReports.filter(r=>!(importDates.includes(r.report_date)&&importIds.includes(r.jd_id)));nd.jdReports.push(...records);save(nd);setJdImportStatus('✅ '+records.length+' rapport(s) importé(s) !');setJdImporting(false);setTimeout(()=>{setShowJdImport(false);setJdImportRows([]);setJdImportStatus('');},2000);};
const[viewDetail,setViewDetail]=useState(null);
const[showForm,setShowForm]=useState(false);
const[formJob,setFormJob]=useState(null);
const[formEmpId,setFormEmpId]=useState('');
const[showDepotForm,setShowDepotForm]=useState(false);const[openDetails,setOpenDetails]=useState({});const[dupJobId,setDupJobId]=useState(null);const[dupDays,setDupDays]=useState(1);const[addEmpOpen,setAddEmpOpen]=useState(null);const[mapModal,setMapModal]=useState(null);const[showPlanMap,setShowPlanMap]=useState(false);const[planMapShowVeille,setPlanMapShowVeille]=useState(false);const[planMapShowSurlend,setPlanMapShowSurlend]=useState(false);
// Autocomplete géocodage Nominatim — déclenché en live (debounce 400ms) au fil de la frappe
// Les résultats sont biaisés sur la zone des dépôts SONECO (priorité aux lieux proches) et triés
// par distance au dépôt le plus proche. Coordonnées stockées en _geocodedGps (champ caché).
const[geocodeAuto,setGeocodeAuto]=useState(null); // {jobId, query, results, loading, anchorRect}
const geocodeTimerRef=useRef(null);
const triggerAutoGeocode=(jobId,query,anchorEl)=>{
  if(geocodeTimerRef.current)clearTimeout(geocodeTimerRef.current);
  const q=(query||'').trim();
  if(q.length<3){setGeocodeAuto(null);return}
  const rect=anchorEl?anchorEl.getBoundingClientRect():null;
  setGeocodeAuto({jobId,query:q,results:[],loading:true,anchorRect:rect});
  geocodeTimerRef.current=setTimeout(async()=>{
    try{
      // Coords des dépôts pour biais géographique
      const depotCoords=(data.depots||[]).map(d=>d._coords?parseCoords(typeof d._coords==='string'?d._coords:d._coords.join(',')):null).filter(x=>x);
      let url='https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q='+encodeURIComponent(q)+'&limit=10&countrycodes=fr';
      if(depotCoords.length){
        const lats=depotCoords.map(d=>d[0]),lons=depotCoords.map(d=>d[1]);
        // viewbox = ±1.5° (~150km) autour de la zone des dépôts ; bounded=0 = préférence, pas filtre strict
        const minLat=Math.min(...lats)-1.5,maxLat=Math.max(...lats)+1.5;
        const minLon=Math.min(...lons)-1.5,maxLon=Math.max(...lons)+1.5;
        url+='&viewbox='+minLon+','+maxLat+','+maxLon+','+minLat+'&bounded=0';
      }
      const r=await fetch(url);
      let results=await r.json()||[];
      // Tri par distance au dépôt le plus proche
      if(depotCoords.length&&results.length){
        results.forEach(res=>{
          const lat=Number(res.lat),lon=Number(res.lon);
          let minD=99999;
          depotCoords.forEach(d=>{const dd=haversine([lat,lon],d);if(dd<minD)minD=dd});
          res._dist=minD;
        });
        results.sort((a,b)=>(a._dist||99999)-(b._dist||99999));
      }
      setGeocodeAuto(g=>g&&g.jobId===jobId&&g.query===q?{...g,results,loading:false}:g);
    }catch(err){console.warn('Géocodage',err);setGeocodeAuto(null)}
  },400);
};
const pickGeocodeResult=(jobId,r)=>{
  const nd=JSON.parse(JSON.stringify(data));
  const jj=nd.jobs.find(x=>x.id===jobId);
  if(jj){jj._geocodedGps=Number(r.lat).toFixed(6)+','+Number(r.lon).toFixed(6);save(nd)}
  setGeocodeAuto(null);
};useEffect(()=>{const close=()=>setAddEmpOpen(null);document.addEventListener('click',close);return()=>document.removeEventListener('click',close);},[]);
const[dragId,setDragId]=useState(null);const[dragOverId,setDragOverId]=useState(null);
const[dragJobId,setDragJobId]=useState(null);const[dragJobOverEmp,setDragJobOverEmp]=useState(null);
const[wirtgenTargetMach,setWirtgenTargetMach]=useState('');const wirtgenRef=useRef(null);
const[depotFormEmpId,setDepotFormEmpId]=useState('');
const[depotFormDepotId,setDepotFormDepotId]=useState('');
const[depotFormActivity,setDepotFormActivity]=useState(DEPOT_ACTIVITIES[0]);
const[depotFormDesc,setDepotFormDesc]=useState('');
const dayJobs=useMemo(()=>(data.jobs||[]).filter(j=>j.date===selDate),[data.jobs,selDate]);
const dayMissions=useMemo(()=>dayJobs.filter(j=>j.type!=='depot'),[dayJobs]);
const detailJob=viewDetail?dayJobs.find(j=>j.id===viewDetail)||(data.jobs||[]).find(j=>j.id===viewDetail):null;
const navDate=d=>{const dt=new Date(selDate);dt.setDate(dt.getDate()+d);setSelDate(fmtDateISO(dt))};
const caTotal=dayMissions.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const withJobs=[...new Set(dayJobs.map(j=>j.employeeId))];
const availDrivers=(data.employees||[]).filter(e=>!withJobs.includes(e.id));
const saveDepotJob=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:depotFormEmpId,type:'depot',depotId:depotFormDepotId,depotActivity:depotFormActivity,depotDescription:depotFormDesc});save(nd);setShowDepotForm(false);setDepotFormEmpId('');setDepotFormDepotId('');setDepotFormActivity(DEPOT_ACTIVITIES[0]);setDepotFormDesc('')};
if(detailJob&&detailJob.type!=='depot')return(<MissionDetail data={data} save={save} job={detailJob} onBack={()=>setViewDetail(null)} onEdit={j=>{setFormJob(j);setShowForm(true)}}/>);
const yearStart=data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1));
const wdpm=data.workDaysPerMonth||22;
const toggleDetail=id=>setOpenDetails(p=>({...p,[id]:!p[id]}));
const getMach=id=>(data.machines||[]).find(m=>m.id===id);
const getClient=id=>(data.clients||[]).find(c=>c.id===id);
const getDepot=id=>(data.depots||[]).find(d=>d.id===id);
const usedMachIds=dayMissions.map(j=>j.machineId);
// Couleur d'une machine :
// - Raboteuse : par LARGEUR de tambour (200+ vert, 150-199 jaune, 130-149 rouge, 100-129 bleu, <100 noir)
// - Balayeuse : vert
// - Citerne : bleu
// - Autre / inconnue : gris
const widthColor=mc=>{if(!mc)return C.muted;if(mc.type==='Balayeuse')return '#16a34a';if(mc.type==='Citerne')return '#3b82f6';if(mc.type!=='Raboteuse')return C.muted;let w=Number(mc.width);if(!w||isNaN(w)){const mt=String(mc.name||'').match(/(\d+)/);if(mt)w=Number(mt[1])}if(!w||isNaN(w))return C.muted;if(w>=200)return '#16a34a';if(w>=150)return '#eab308';if(w>=130)return '#dc2626';if(w>=100)return '#3b82f6';return '#1e293b'};
// Catégorie d'une machine (= bande de largeur pour Raboteuse, type pour autres) — pour espacer visuellement
const machCategory=mc=>{if(!mc)return 'x';if(mc.type==='Balayeuse')return 'bal';if(mc.type==='Citerne')return 'cit';if(mc.type!=='Raboteuse')return 'oth';let w=Number(mc.width);if(!w||isNaN(w)){const mt=String(mc.name||'').match(/(\d+)/);if(mt)w=Number(mt[1])}if(!w||isNaN(w))return 'r-?';if(w>=200)return 'r-200';if(w>=150)return 'r-150';if(w>=130)return 'r-130';if(w>=100)return 'r-100';return 'r-low'};
const renderCol=(types,label)=>{
const allM=(data.machines||[]).filter(m=>types.includes(m.type));
const freeM=allM.filter(m=>!usedMachIds.includes(m.id));
const empIdsWithJobs=dayJobs.filter(j=>{const m=getMach(j.machineId);return m&&types.includes(m.type)}).map(j=>j.employeeId);
const defaultEmpIds=(data.employees||[]).filter(e=>{const m=getMach(e.machineId);if(!m||!types.includes(m.type))return false;const empDayJobs=dayJobs.filter(j=>j.employeeId===e.id&&j.type!=='depot');if(empDayJobs.length===0)return true;const hasJobInThisCol=empDayJobs.some(j=>{const jm=getMach(j.machineId);return jm&&types.includes(jm.type)});const hasJobInOtherCol=empDayJobs.some(j=>{const jm=getMach(j.machineId);return jm&&!types.includes(jm.type)});if(hasJobInOtherCol&&!hasJobInThisCol)return false;return true}).map(e=>e.id);
const empIdsRaw=[...new Set([...defaultEmpIds,...empIdsWithJobs])];
const orderKey=selDate+'_'+types.join(',');
const savedOrder=(data.cardOrder||{})[orderKey]||[];
const empIds=[...empIdsRaw].sort((a,b)=>{const ia=savedOrder.indexOf(a);const ib=savedOrder.indexOf(b);if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return-1;return ia-ib});
const assignedMachIds=new Set((data.employees||[]).map(e=>e.machineId).filter(Boolean));
const driverBusyOnOtherMach=new Set();
(data.employees||[]).forEach(emp2=>{if(emp2.machineId){const empJobs=dayJobs.filter(j=>j.employeeId===emp2.id&&j.type!=='depot');const hasJobOnOther=empJobs.some(j=>j.machineId&&j.machineId!==emp2.machineId);if(hasJobOnOther&&!empJobs.some(j=>j.machineId===emp2.machineId)){driverBusyOnOtherMach.add(emp2.machineId)}}});
const unassignedM=allM.filter(m=>!assignedMachIds.has(m.id)||driverBusyOnOtherMach.has(m.id));
const unassignedOrder=(data.cardOrder||{})[orderKey+'_u']||[];
const allCardIds=[...empIds.map(id=>'e_'+id),...unassignedM.map(m=>'m_'+m.id)];
// Ordre des machines GLOBAL (pas par jour) — drag-drop met a jour data.machineOrder
// Pour les machines pas encore drag-droppees, on complete avec un ordre alphabetique stable
// (evite que les nouvelles machines bougent au hasard d'un jour a l'autre).
const machineOrderG=data.machineOrder||[];
const allMachineIds=(data.machines||[]).map(m=>m.id);
const effectiveOrder=[...machineOrderG.filter(id=>allMachineIds.includes(id))];
const remainingMachs=(data.machines||[]).filter(m2=>!effectiveOrder.includes(m2.id)).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
remainingMachs.forEach(m2=>effectiveOrder.push(m2.id));
const getMachineForCard=(cardId)=>{
if(cardId.startsWith('m_'))return cardId.slice(2);
const empId2=cardId.slice(2);
const empJobs2=dayJobs.filter(j=>j.employeeId===empId2&&j.type!=='depot');
const colJobs2=empJobs2.filter(j=>{const m=getMach(j.machineId);return m&&types.includes(m.type)});
if(colJobs2.length>0)return colJobs2[0].machineId;
const emp2=(data.employees||[]).find(e=>e.id===empId2);
return emp2?emp2.machineId:null;
};
const sortedCards=[...allCardIds].sort((a,b)=>{const ma=getMachineForCard(a);const mb=getMachineForCard(b);const ia=ma?effectiveOrder.indexOf(ma):-1;const ib=mb?effectiveOrder.indexOf(mb):-1;if(ia===-1&&ib===-1)return 0;if(ia===-1)return 1;if(ib===-1)return-1;return ia-ib});
const onDragStart=(e,cardId)=>{setDragId(cardId);e.dataTransfer.effectAllowed='move'};
const onDragOver=(e,cardId)=>{e.preventDefault();if(cardId!==dragId)setDragOverId(cardId)};
const onDragEnd=()=>{if(dragId&&dragOverId&&dragId!==dragOverId){const draggedMach=getMachineForCard(dragId);const targetMach=getMachineForCard(dragOverId);if(draggedMach&&targetMach&&draggedMach!==targetMach){let order=[...(data.machineOrder||[])];const allMachineIds=(data.machines||[]).map(m=>m.id);allMachineIds.forEach(mid=>{if(!order.includes(mid))order.push(mid)});order=order.filter(mid=>allMachineIds.includes(mid));const fromIdx=order.indexOf(draggedMach);const toIdx=order.indexOf(targetMach);if(fromIdx>=0&&toIdx>=0){order.splice(fromIdx,1);order.splice(toIdx,0,draggedMach);const nd=JSON.parse(JSON.stringify(data));nd.machineOrder=order;save(nd)}}}setDragId(null);setDragOverId(null)};
const onJobDragStart=(e,jobId)=>{const tag=e.target.tagName;if(tag==='INPUT'||tag==='SELECT'||tag==='BUTTON'||tag==='TEXTAREA'||tag==='OPTION'){e.preventDefault();return}e.stopPropagation();setDragJobId(jobId);e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain','job:'+jobId)}catch(_){}};
const onJobDragOver=(e,empId)=>{if(!dragJobId)return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';if(empId!==dragJobOverEmp)setDragJobOverEmp(empId)};
const onJobDrop=(e,targetEmpId)=>{if(!dragJobId)return;e.preventDefault();e.stopPropagation();const nd=JSON.parse(JSON.stringify(data));const jj=(nd.jobs||[]).find(x=>x.id===dragJobId);if(jj&&targetEmpId&&jj.employeeId!==targetEmpId){const targetEmp=(nd.employees||[]).find(x=>x.id===targetEmpId);jj.employeeId=targetEmpId;if(targetEmp&&targetEmp.machineId)jj.machineId=targetEmp.machineId;save(nd)}setDragJobId(null);setDragJobOverEmp(null)};
const onJobDragEnd=()=>{setDragJobId(null);setDragJobOverEmp(null)};
return(
<div>
<datalist id="planning-clients-list">{(data.clients||[]).map(c2=><option key={c2.id} value={c2.name}/>)}</datalist>
<div style={{background:C.card,borderRadius:8,padding:'10px 14px',marginBottom:10,marginTop:10,border:'1px solid '+C.border}}>
<span style={{color:MC[types[0]]||C.green,fontWeight:800,fontSize:18}}>{label}</span>
</div>
{(()=>{let prevCat=null;return sortedCards.map(cardId=>{
// showSep = changement de catégorie de machine entre cette card et la précédente
const curMach=getMachineForCard(cardId);
const curCat=curMach?machCategory(getMach(curMach)):'x';
const showSep=prevCat!==null&&prevCat!==curCat;
prevCat=curCat;
if(cardId.startsWith('m_')){
const mId=cardId.slice(2);const um=allM.find(x=>x.id===mId);if(!um)return null;
const umHasJobWithDriver=dayJobs.some(j2=>j2.machineId===um.id&&j2.employeeId&&j2.type!=='depot');
if(umHasJobWithDriver)return null;
if(assignedMachIds.has(um.id)&&!driverBusyOnOtherMach.has(um.id))return null;
const umColor=widthColor(um);
const umJobs=dayJobs.filter(j2=>j2.machineId===um.id);
if(umJobs.length===0){
const createUmJob=(field,value)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const newJ={id:uid(),date:selDate,employeeId:'',machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false};newJ[field]=value;nd.jobs.push(newJ);save(nd)};
return(<React.Fragment key={cardId}>
<div draggable onDragStart={e=>onDragStart(e,cardId)} onDragOver={e=>onDragOver(e,cardId)} onDragEnd={onDragEnd} style={{background:C.card,borderRadius:10,marginBottom:12,marginTop:showSep?28:0,border:'2px solid '+(dragOverId===cardId?C.accent+'80':umColor+'40'),borderLeft:'6px solid '+umColor,overflow:'hidden',boxShadow:'0 2px 6px rgba(0,0,0,.06)',display:'flex',opacity:dragId===cardId?0.5:1,cursor:'grab'}}>
{/* Côté gauche : select chauffeur + nom machine */}
<div style={{width:95,minWidth:95,maxWidth:95,padding:'10px 6px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:'2px solid '+umColor+'20',background:umColor+'08',gap:4}}>
<select style={{fontSize:13,fontWeight:700,border:'1px solid '+C.border,borderRadius:6,padding:'3px 4px',background:'#fff',width:'100%',textAlign:'center'}} value="" onChange={e2=>{if(!e2.target.value)return;const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:e2.target.value,machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd)}}><option value="">Chauff.</option>{(data.employees||[]).map(e2=><option key={e2.id} value={e2.id}>{e2.name}</option>)}</select>
<div style={{fontSize:13,fontWeight:700,color:umColor,textAlign:'center',lineHeight:'1.2'}}>{um.name}{um.width?' ('+um.width+')':''}</div>
</div>
{/* Côté droit : ligne placeholder pour saisie chantier */}
<div style={{flex:1,minWidth:0}}>
<div style={{padding:'6px 10px',display:'flex',alignItems:'center',justifyContent:'center'}}>
<button onClick={()=>createUmJob('billingStart','08:00')} title="Ajouter un chantier sans chauffeur" style={{background:umColor,color:'#fff',border:'none',borderRadius:6,width:28,height:28,cursor:'pointer',fontSize:18,fontWeight:700,lineHeight:1,padding:0,flexShrink:0}}>+</button>
</div>
</div>
</div></React.Fragment>)}
return(<React.Fragment key={cardId}><div draggable onDragStart={e=>onDragStart(e,cardId)} onDragOver={e=>onDragOver(e,cardId)} onDragEnd={onDragEnd} style={{background:C.card,borderRadius:10,marginBottom:12,marginTop:showSep?28:0,border:'2px solid '+(dragOverId===cardId?C.accent+'80':umColor+'40'),borderLeft:'6px solid '+umColor,boxShadow:'0 2px 6px rgba(0,0,0,.06)',display:'flex',opacity:dragId===cardId?0.5:1,cursor:'grab'}}>
<div style={{width:100,minWidth:100,maxWidth:100,padding:'10px 6px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:'2px solid '+umColor+'20',background:umColor+'08',gap:4,borderTopLeftRadius:7,borderBottomLeftRadius:7}}>
<select style={{fontSize:13,fontWeight:700,border:'1px solid '+C.border,borderRadius:6,padding:'3px 4px',background:'#fff',width:'100%',textAlign:'center'}} value="" onChange={e2=>{if(!e2.target.value)return;const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const existingJ=nd.jobs.filter(x=>x.machineId===um.id&&x.date===selDate);if(existingJ.length>0){existingJ.forEach(x2=>{x2.employeeId=e2.target.value})}else{nd.jobs.push({id:uid(),date:selDate,employeeId:e2.target.value,machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false})}save(nd)}}><option value="">Chauff.</option>{(data.employees||[]).map(e2=><option key={e2.id} value={e2.id}>{e2.name}</option>)}</select>
<div style={{fontSize:13,fontWeight:700,color:umColor,textAlign:'center'}}>{um.name}{um.width?' ('+um.width+')':''}</div>
<button onClick={e=>{e.stopPropagation();const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:'',machineId:um.id,clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd)}} style={{background:C.accent,color:'#fff',border:'none',borderRadius:4,width:22,height:22,cursor:'pointer',fontSize:14,fontWeight:700,lineHeight:'20px',padding:0}}>+</button>
</div>
<div style={{flex:1,minWidth:0}}>
{umJobs.map(uj=>{const ujCl=getClient(uj.clientId);const ujM=um;const ujMt=um.type;return(
<div key={uj.id} style={{borderBottom:'1px solid '+C.border,background:uj.isNight?'#fee2e2':uj.ack?'#dcfce7':C.card}}>
<div style={{padding:'6px 10px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
<input key={'ujcl_'+uj.id+'_'+(uj.clientId||'_')} list="planning-clients-list" placeholder="Client" defaultValue={ujCl?ujCl.name:''} onChange={e=>{const v=e.target.value;const matched=(data.clients||[]).find(c2=>c2.name===v);if(!matched)return;const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(!jj)return;jj.clientId=matched.id;if(ujM&&jj.forfaitType){const p=getForfaitPrice(nd,matched.id,ujM,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}} onBlur={e=>{const v=e.target.value.trim();const exists=(data.clients||[]).find(c2=>c2.name.toLowerCase()===v.toLowerCase());if(exists){if(uj.clientId!==exists.id){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.clientId=exists.id;if(ujM&&jj.forfaitType){const p=getForfaitPrice(nd,exists.id,ujM,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}}return}if(!v){if(uj.clientId){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.clientId='';save(nd)}}return}const nd=JSON.parse(JSON.stringify(data));if(!nd.clients)nd.clients=[];const nc={id:uid(),name:v,forfaitType:'standard',agencies:[],siteManagers:[]};nd.clients.push(nc);const jj=nd.jobs.find(x=>x.id===uj.id);if(jj)jj.clientId=nc.id;save(nd)}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:100,maxWidth:150}}/>
{ujCl&&(ujCl.agencies||[]).length>0&&<select value={uj.agencyName||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.agencyName=e.target.value;save(nd)}}} title={uj.agencyName?'Agence : '+uj.agencyName:'Choisir une agence'} style={{fontSize:13,padding:'4px 4px',borderRadius:6,border:'1px solid '+C.border,background:uj.agencyName?'#eff6ff':'#fff',color:uj.agencyName?'#1d4ed8':C.dim,fontWeight:uj.agencyName?700:400,width:80,maxWidth:90,flexShrink:0}}><option value="">Agence</option>{(ujCl.agencies||[]).map((a,i)=><option key={i} value={a}>{a}</option>)}</select>}
<select value={uj.siteManager||''} onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau chef'+(uj.agencyName?' (agence : '+uj.agencyName+')':'')+' :');if(n){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.siteManager=n;const cl2=(nd.clients||[]).find(c2=>c2.id===uj.clientId);if(cl2){if(!cl2.siteManagers)cl2.siteManagers=[];if(!cl2.siteManagers.find(s=>s.name===n&&(s.agency||'')===(uj.agencyName||''))){const ph=prompt('Tel (optionnel):','')||'';cl2.siteManagers.push({name:n,phone:ph,agency:uj.agencyName||''});jj.siteManagerPhone=ph}}save(nd)}}}else{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.siteManager=e.target.value;const cl2=(data.clients||[]).find(c2=>c2.id===uj.clientId);const sm=(cl2&&cl2.siteManagers||[]).find(s=>s.name===e.target.value&&(!uj.agencyName||!s.agency||s.agency===uj.agencyName));if(sm)jj.siteManagerPhone=sm.phone||'';save(nd)}}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:80,maxWidth:130}}>
<option value="">Chef</option>{(ujCl&&ujCl.siteManagers||[]).filter(s=>!uj.agencyName||!s.agency||s.agency===uj.agencyName).map((s,si)=><option key={si} value={s.name}>{s.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<input value={uj.location||''} placeholder="Lieu / adresse" onChange={e=>{const v=e.target.value;const tgt=e.target;const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.location=v;if(jj._geocodedGps)jj._geocodedGps='';save(nd)}triggerAutoGeocode(uj.id,v,tgt)}} onFocus={e=>{if(uj.location&&uj.location.trim().length>=3&&!uj._geocodedGps)triggerAutoGeocode(uj.id,uj.location,e.target)}} style={{fontSize:15,padding:'4px 8px',borderRadius:6,border:'1px solid '+(uj._geocodedGps?C.green:C.border),minWidth:100,flex:1,maxWidth:220,background:uj._geocodedGps?'#dcfce7':'#fff'}}/>
<input type="time" value={uj.billingStart||'08:00'} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.billingStart=e.target.value;save(nd)}}} style={{fontSize:15,padding:'4px 4px',borderRadius:6,border:'2px solid '+C.orange+'40',background:C.orange+'08',color:C.orange,fontWeight:700,width:75}}/>
{/* Champ GPS masqué : alimenté automatiquement via géocodage (caché à l'utilisateur) */}
{(()=>{const gpsJ=parseCoords(uj.gps||uj._geocodedGps);const empCo2=uj.employeeId?getEmpCoords(data,uj.employeeId):null;const depOptions2=[{id:'home',name:'Dom.',co:empCo2},...(data.depots||[]).map(d2=>({id:d2.id,name:d2.name,co:d2._coords?parseCoords(typeof d2._coords==='string'?d2._coords:d2._coords.join(',')):null}))].map(o=>({...o,km:o.co&&gpsJ?+(haversine(o.co,gpsJ)*1.3).toFixed(0):null}));const arrOptions2=depOptions2.map(o=>({...o,km:o.co&&gpsJ?+(haversine(gpsJ,o.co)*1.3).toFixed(0):null}));const validDep=depOptions2.filter(o=>o.km!==null);const validArr=arrOptions2.filter(o=>o.km!==null);const shortDep=validDep.length>0?validDep.reduce((mn,o)=>o.km<mn.km?o:mn,validDep[0]):null;const shortArr=validArr.length>0?validArr.reduce((mn,o)=>o.km<mn.km?o:mn,validArr[0]):null;
if(gpsJ&&!uj.startFrom&&shortDep){setTimeout(()=>{const nd2=JSON.parse(JSON.stringify(data));const jj2=nd2.jobs.find(x=>x.id===uj.id);if(jj2&&!jj2.startFrom){jj2.startFrom=shortDep.id;jj2.kmAller=shortDep.km;jj2.travelMinAller=Math.round((shortDep.km/80)*60);if(!jj2.endAt&&shortArr){jj2.endAt=shortArr.id;jj2.kmRetour=shortArr.km;jj2.travelMinRetour=Math.round((shortArr.km/80)*60)}jj2.distanceKm=(jj2.kmAller||0)+(jj2.kmRetour||0);jj2.travelMin=(jj2.travelMinAller||0)+(jj2.travelMinRetour||0);save(nd2)}},0)}
return(<React.Fragment>
<select value={uj.startFrom||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.startFrom=e.target.value;const sel2=depOptions2.find(o=>o.id===e.target.value);jj.kmAller=sel2&&sel2.km?sel2.km:0;jj.travelMinAller=sel2&&sel2.km?Math.round((sel2.km/80)*60):0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);jj.travelMin=(jj.travelMinAller||0)+(jj.travelMinRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 3px',borderRadius:4,border:'1px solid #0891b240',background:uj.startFrom&&shortDep&&uj.startFrom===shortDep.id?'#0891b218':'#0891b208',color:'#0891b2',fontWeight:600,minWidth:60,maxWidth:110}}>
<option value="">↗Dep</option>{depOptions2.map(o=><option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km':''}{shortDep&&o.id===shortDep.id?' ★':''}</option>)}
</select>
<select value={uj.endAt||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.endAt=e.target.value;const sel2=arrOptions2.find(o=>o.id===e.target.value);jj.kmRetour=sel2&&sel2.km?sel2.km:0;jj.travelMinRetour=sel2&&sel2.km?Math.round((sel2.km/80)*60):0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);jj.travelMin=(jj.travelMinAller||0)+(jj.travelMinRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 3px',borderRadius:4,border:'1px solid #7c3aed40',background:uj.endAt&&shortArr&&uj.endAt===shortArr.id?'#7c3aed18':'#7c3aed08',color:'#7c3aed',fontWeight:600,minWidth:60,maxWidth:110}}>
<option value="">↙Arr.</option>{arrOptions2.map(o=><option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km':''}{shortArr&&o.id===shortArr.id?' ★':''}</option>)}
</select>
</React.Fragment>)})()}
<select value={uj.forfaitType||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj&&ujM){jj.forfaitType=e.target.value;const p=getForfaitPrice(nd,uj.clientId,ujM,e.target.value,uj.citOption,uj.isNight);if(p)jj.priceForfait=p;save(nd)}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'2px solid '+(uj.forfaitType?FC[uj.forfaitType]||C.accent:C.border),background:uj.forfaitType?(FC[uj.forfaitType]||C.accent)+'15':'#fff',color:uj.forfaitType?FC[uj.forfaitType]||C.accent:C.dim,fontWeight:uj.forfaitType?700:400,minWidth:40}}>
<option value="">F</option>{(ujMt==='Citerne'?['Demi-journee','Journee']:['2h','4h','6h','8h']).map(f=><option key={f} value={f}>{f}</option>)}
</select>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj&&ujM){jj.hasTransfer=!jj.hasTransfer;if(jj.hasTransfer&&!jj.transferPrice){const tp=getTransferPrice(nd,uj.clientId,ujM,uj.citOption,uj.isNight);jj.transferPrice=tp||0}save(nd)}}} style={{padding:'4px 8px',borderRadius:6,fontSize:14,border:'2px solid '+(uj.hasTransfer?C.purple:C.muted),background:uj.hasTransfer?C.purple+'20':'transparent',color:uj.hasTransfer?C.purple:C.dim,cursor:'pointer',fontWeight:uj.hasTransfer?700:400}}>{uj.hasTransfer?'T ✓':'+T'}</button>
<div style={{marginLeft:'auto',display:'flex',gap:4,alignItems:'center'}}>
<div style={{position:'relative'}}><button onClick={e=>{e.stopPropagation();setAddEmpOpen(addEmpOpen===uj.id?null:uj.id)}} style={{padding:'3px 10px',borderRadius:6,fontSize:15,border:'2px solid '+C.cyan,background:addEmpOpen===uj.id?C.cyan+'22':'transparent',color:C.cyan,cursor:'pointer',fontWeight:700,lineHeight:1}}>+</button>{addEmpOpen===uj.id&&<div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'110%',right:0,zIndex:999,background:'#fff',border:'1px solid '+C.border,borderRadius:8,boxShadow:'0 4px 20px #0003',minWidth:160,overflow:'hidden'}}>{(data.employees||[]).filter(e2=>e2.id!==(uj.employeeId||'')).map(e2=><div key={e2.id} onClick={()=>{const selEmp2=(data.employees||[]).find(x=>x.id===e2.id);const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const nj={...JSON.parse(JSON.stringify(uj)),id:uid(),employeeId:e2.id,machineId:selEmp2?selEmp2.machineId||uj.machineId:uj.machineId,sent:false,ack:false};nd.jobs.push(nj);save(nd);setAddEmpOpen(null)}} style={{padding:'9px 14px',cursor:'pointer',fontSize:14,borderBottom:'1px solid #f1f5f9',color:C.text,userSelect:'none'}} onMouseEnter={e=>e.currentTarget.style.background='#f0f9ff'} onMouseLeave={e=>e.currentTarget.style.background=''}>{e2.name}</div>)}</div>}</div>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===uj.id);if(jj){jj.isNight=!jj.isNight;if(jj.priceForfait&&jj.forfaitType){const p=getForfaitPrice(nd,jj.clientId,ujM,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}}} style={{padding:'3px 8px',borderRadius:6,fontSize:12,border:'2px solid '+(uj.isNight?C.red:C.muted),background:uj.isNight?C.red+'20':'transparent',color:uj.isNight?C.red:C.dim,cursor:'pointer',fontWeight:uj.isNight?700:400}}>Nuit</button>
<button onClick={()=>{setDupJobId(uj.id);setDupDays(1)}} style={{background:'none',border:'2px solid #d97706',borderRadius:6,fontSize:12,cursor:'pointer',padding:'3px 6px',color:'#d97706',fontWeight:600}} title="Dupliquer">D</button>
<button onClick={()=>toggleDetail(uj.id)} style={{background:'none',border:'2px solid '+C.border,borderRadius:6,fontSize:14,cursor:'pointer',padding:'4px 8px',color:C.dim,fontWeight:600}}>{openDetails[uj.id]?'▲':'▼'}</button>
<button onClick={e=>{e.stopPropagation();const mNorm=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');const machName=ujM?ujM.name:'';const mr=(data.machineReports||[]).find(r=>mNorm(r.machineName)===mNorm(machName)&&r.date===uj.date);const exp={exportedAt:new Date().toISOString(),chantier:uj,client:ujCl||null,machine:ujM||null,chauffeur:null,rapportWirtgen:mr||null};const blob=new Blob([JSON.stringify(exp,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='rapport_'+(machName||'chantier').replace(/\s/g,'_')+'_'+uj.date+'.json';a.click();URL.revokeObjectURL(url)}} title="Exporter ce chantier + son rapport Wirtgen en JSON" style={{background:'none',border:'2px solid #0891b2',borderRadius:6,fontSize:13,cursor:'pointer',padding:'3px 6px',color:'#0891b2',fontWeight:700}}>📤</button>
<button onClick={()=>{if(confirm('Supprimer ?')){const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(x=>x.id!==uj.id);save(nd)}}} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.red}}>×</button>
</div>
</div>
</div>)})}
</div>
</div></React.Fragment>)}
const eId=cardId.slice(2);
const emp=(data.employees||[]).find(e=>e.id===eId);if(!emp)return null;
const ejAll=dayJobs.filter(j=>j.employeeId===eId&&(j.type==='depot'||types.includes((getMach(j.machineId)||{}).type)));
const ej=ejAll.filter(j=>j.type!=='depot');
const depotJobs=ejAll.filter(j=>j.type==='depot');
const ca=ej.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const te=(data.timeEntries||[]).filter(t=>t.empId===eId&&t.date===selDate);
const hasJ=ejAll.length>0;
const hasMissions=ej.length>0;
let workMin=0,pauseMin=0,totalMinDay=0;
te.forEach(t=>{if(t.startTime&&t.endTime){const total=calcDiffMin(t.startTime,t.endTime);workMin+=Math.max(0,total-(t.pauseMin||0));pauseMin+=(t.pauseMin||0);totalMinDay+=total}});
const isMonthly=emp.salaryType==='monthly';
const hourly=isMonthly?0:Number(emp.hourlySalary)||0;
const dailySalary=isMonthly?(Number(emp.monthlySalary)||0)/wdpm:0;
const salTotal=isMonthly?dailySalary:(workMin/60*hourly);
const mainTE=te.find(t=>t.startTime&&t.endTime)||te.find(t=>t.startTime)||te[0];
const pMinGlobal=mainTE?(mainTE.pauseMin||0):0;
const firstJob=ej.length>0?ej.reduce((a,b)=>(a.billingStart||'99')<(b.billingStart||'99')?a:b):null;
const lastJob=ej.length>0?ej.reduce((a,b)=>(a.billingStart||'')<(b.billingStart||'')?b:a):null;
const theoFirst=firstJob?calcTheoreticalTimes(firstJob,data,pMinGlobal):null;
const theoLast=lastJob&&lastJob!==firstJob?calcTheoreticalTimes(lastJob,data,pMinGlobal):theoFirst;
const tolVal=theoFirst?theoFirst.tolerance:(data.toleranceMinutes!=null?data.toleranceMinutes:TOLERANCE_MINUTES);
let startBadge=null,endBadge=null,overtimeMinEmb=0,overtimeMinDeb=0;
let surcoutEmb=0,surcoutDeb=0;
if(theoFirst&&mainTE&&mainTE.startTime){const[ash,asm]=mainTE.startTime.split(':').map(Number);const actualMin=ash*60+asm;const dS=actualMin-theoFirst.theoStartMin;if(Math.abs(dS)<=tolVal)startBadge={text:'Emb. OK',color:C.green};else if(dS<0){overtimeMinEmb=Math.abs(dS);surcoutEmb=(overtimeMinEmb/60)*hourly;startBadge={text:'Emb. +'+overtimeMinEmb+'min tot = '+fmtMoney(surcoutEmb),color:C.orange}}else startBadge={text:'Emb. '+dS+'min retard',color:C.red}}
if(theoLast&&mainTE&&mainTE.endTime){const[aeh,aem]=mainTE.endTime.split(':').map(Number);const actualMin=aeh*60+aem;const dE=actualMin-theoLast.theoEndMin;if(Math.abs(dE)<=tolVal)endBadge={text:'Deb. OK',color:C.green};else if(dE>0){overtimeMinDeb=dE;surcoutDeb=(overtimeMinDeb/60)*hourly;endBadge={text:'Deb. +'+overtimeMinDeb+'min tard = '+fmtMoney(surcoutDeb),color:C.red}}else endBadge={text:'Deb. '+Math.abs(dE)+'min tot',color:C.orange}}
let tempsDepotMin=0,coutDepot=0;
if(mainTE&&mainTE.startTime&&mainTE.endTime&&hasMissions){
const tempsChantiers=ej.reduce((s,j)=>s+forfaitHours(j.forfaitType)*60+(0),0);
const tempsPause=pauseMin;
const tempsRoute=ej.reduce((s,j)=>s+(Number(j.travelMinAller)||0)+(Number(j.travelMinRetour)||0),0);
const tpDep=(data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART);
const tpArr=(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const tempsExtra=(tpDep+tpArr)*ej.length;
tempsDepotMin=Math.max(0,totalMinDay-tempsChantiers-tempsPause-tempsRoute-tempsExtra);
coutDepot=(tempsDepotMin/60)*hourly}
if(!hasMissions&&workMin>0){tempsDepotMin=workMin;coutDepot=salTotal}
let totalCostsDay=0,totalRevDay=0;
const chargesRate=Number(emp.chargesRate)||45;
const mealPrice=mainTE?(mainTE.mealType==='RESTO'?Number(data.restoPrice)||15:(mainTE.mealType==='PANIER'?Number(data.paniersPrice)||12:0)):0;
const truck2g=(data.trucks||[]).find(t=>emp&&t.id===emp.truckId);
const jobCalcs=ej.map(j=>{const m=getMach(j.machineId);const mt=m?m.type:'';const fuelType=getMachineFuelType(data,j.machineId);const truck2=truck2g;const truckC=truck2?Number(truck2.fuelPer100)||25:25;const trajL=mt==='Raboteuse'?((j.distanceKm||0)/100)*truckC:(m?(Number(m.fuelConsumption)||0)*((j.travelMin||0)/60):0);const fuelPr=getFuelPrice(data,fuelType,j.startFrom!=='home'?j.startFrom:null);const trajCost=trajL*fuelPr;const machFuelPr=getFuelPrice(data,fuelType,j.machineFuelDepot);const machCost=(j.machineFuelL||0)*machFuelPr;const salRoute=((j.travelMin||0)/60)*hourly;const rev=(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0);const credM=m?(Number(m.creditMonthly)||0)/wdpm:0;const assM=m?((m.insuranceMonthly||0)/wdpm):0;const ctM=m?((m.ctCost||0)/12)/wdpm:0;const credT=truck2?(Number(truck2.creditMonthly)||0)/wdpm:0;const assT=truck2?((truck2.insuranceMonthly||0)/wdpm):0;const ctT=truck2?((truck2.ctCost||0)/12)/wdpm:0;const entretienMach=(data.interventions||[]).filter(ii=>ii.machineId===(m?m.id:'')&&ii.date>=yearStart&&ii.date<=selDate).reduce((s2,ii)=>s2+(ii.totalCost||0),0);const entretienCam=(data.interventions||[]).filter(ii=>truck2&&ii.truckId===truck2.id&&ii.date>=yearStart&&ii.date<=selDate).reduce((s2,ii)=>s2+(ii.totalCost||0),0);return{j,m,mt,fuelType,trajL,trajCost,machCost,salRoute,rev,cl:getClient(j.clientId),credM,assM,ctM,credT,assT,ctT,entretienMach,entretienCam}});
totalRevDay=jobCalcs.reduce((s,c)=>s+c.rev,0);
const totalSalRouteDay=jobCalcs.reduce((s,c)=>s+c.salRoute,0);
const salChantier=Math.max(0,salTotal-totalSalRouteDay);
const salTotalCharges=salTotal*(1+chargesRate/100);
jobCalcs.forEach(c=>{const ratio=totalRevDay>0?(c.rev/totalRevDay):0;const salChMission=salChantier*ratio;const surcDebMission=surcoutDeb*ratio;const fixesJour=c.credM+c.assM+c.ctM+c.credT+c.assT+c.ctT;c.salChMission=salChMission;c.surcMission=surcDebMission;c.fixesJour=fixesJour;c.fixesMach=c.credM+c.assM+c.ctM;c.fixesCam=c.credT+c.assT+c.ctT;c.salTotalMission=salChMission+c.salRoute+surcDebMission+mealPrice*ratio;c.totalCost=c.trajCost+c.machCost+c.salTotalMission+fixesJour;c.benefBrut=c.rev-c.totalCost;c.revForfait=c.j.priceForfait||0;c.revTransfert=c.j.hasTransfer?c.j.transferPrice||0:0;c.coutsMachJour=c.machCost+c.fixesMach+salChMission+mealPrice*ratio;c.coutsCamJour=c.trajCost+c.fixesCam+c.salRoute});
totalCostsDay=jobCalcs.reduce((s,c)=>s+c.totalCost,0)+surcoutEmb+coutDepot;
const benefDay=totalRevDay-totalCostsDay;
const dTotalEntretienMach=jobCalcs.reduce((s,c)=>s+c.entretienMach,0);
const dTotalEntretienCam=jobCalcs.length>0?jobCalcs[0].entretienCam:0;
const dTotalEntretien=dTotalEntretienMach+dTotalEntretienCam;
const dTotalSalaire=jobCalcs.reduce((s,c)=>s+c.salTotalMission,0)+surcoutEmb+coutDepot;
const dTotalCarbu=jobCalcs.reduce((s,c)=>s+c.trajCost+c.machCost,0);
const dTotalFixes=jobCalcs.reduce((s,c)=>s+c.fixesJour,0);
// --- MACHINE: remboursé par forfaits ---
const machIds=[...new Set(jobCalcs.map(c=>c.m?c.m.id:'').filter(Boolean))];
const allPastJobsMach=(data.jobs||[]).filter(j2=>j2.date>=yearStart&&j2.date<=selDate&&j2.type!=='depot'&&machIds.includes(j2.machineId));
const revMachCum=allPastJobsMach.reduce((s2,j2)=>s2+(j2.priceForfait||0),0);
const coutsMachCum=(()=>{let cm=0;allPastJobsMach.forEach(j2=>{const m2=getMach(j2.machineId);const emp2=(data.employees||[]).find(e=>e.id===j2.employeeId);const hr2=emp2?Number(emp2.hourlySalary)||0:0;const cr2=emp2?Number(emp2.chargesRate)||45:45;const ml2=emp2?Number(emp2.mealAllowance)||12:12;const fh2=forfaitHours(j2.forfaitType);const ft2=getMachineFuelType(data,j2.machineId);const fp2=getFuelPrice(data,ft2,j2.machineFuelDepot);cm+=(j2.machineFuelL||0)*fp2;if(m2){cm+=(Number(m2.creditMonthly)||0)/wdpm;cm+=(m2.insuranceMonthly||0)/wdpm;cm+=((m2.ctCost||0)/12)/wdpm}cm+=(fh2*hr2)*(1+cr2/100);cm+=ml2});return cm})();
const benefMachCum=revMachCum-coutsMachCum;
const resteMach=dTotalEntretienMach>0?Math.max(0,dTotalEntretienMach-Math.max(0,benefMachCum)):0;
const machRembourse=dTotalEntretienMach>0&&resteMach<=0;
const pctMach=dTotalEntretienMach>0?Math.min(100,(Math.max(0,benefMachCum)/dTotalEntretienMach)*100):100;
const benefMachAffiche=dTotalEntretienMach>0&&resteMach>0?0:Math.max(0,benefMachCum)-dTotalEntretienMach;
// --- CAMION: remboursé par transferts ---
const truckIdD=truck2g?truck2g.id:'';
const allPastJobsCam=(data.jobs||[]).filter(j2=>{if(j2.date<yearStart||j2.date>selDate||j2.type==='depot'||!j2.hasTransfer)return false;const m2=getMach(j2.machineId);if(!m2||m2.type!=='Raboteuse')return false;const e2=(data.employees||[]).find(e=>e.id===j2.employeeId);return e2&&e2.truckId===truckIdD});
const revCamCum=allPastJobsCam.reduce((s2,j2)=>s2+(j2.transferPrice||0),0);
const coutsCamCum=(()=>{let cc=0;const allTrJobs=(data.jobs||[]).filter(j2=>{if(j2.date<yearStart||j2.date>selDate||j2.type==='depot')return false;const m2=getMach(j2.machineId);if(!m2||m2.type!=='Raboteuse')return false;const e2=(data.employees||[]).find(e=>e.id===j2.employeeId);return e2&&e2.truckId===truckIdD});allTrJobs.forEach(j2=>{const emp2=(data.employees||[]).find(e=>e.id===j2.employeeId);const hr2=emp2?Number(emp2.hourlySalary)||0:0;const cr2=emp2?Number(emp2.chargesRate)||45:45;const ft2=getMachineFuelType(data,j2.machineId);const fp2=getFuelPrice(data,ft2,j2.startFrom!=='home'?j2.startFrom:null);const trC2=truck2g?Number(truck2g.fuelPer100)||25:25;const trajL2=((j2.distanceKm||0)/100)*trC2;cc+=trajL2*fp2;cc+=((j2.travelMin||0)/60)*hr2*(1+cr2/100)});if(truck2g){const daysUsed=[...new Set(allTrJobs.map(j2=>j2.date))].length||1;cc+=((Number(truck2g.creditMonthly)||0)/wdpm)*daysUsed;cc+=((truck2g.insuranceMonthly||0)/wdpm)*daysUsed;cc+=(((truck2g.ctCost||0)/12)/wdpm)*daysUsed}return cc})();
const benefCamCum=revCamCum-coutsCamCum;
const resteCam=dTotalEntretienCam>0?Math.max(0,dTotalEntretienCam-Math.max(0,benefCamCum)):0;
const camRembourse=dTotalEntretienCam>0&&resteCam<=0;
const pctCam=dTotalEntretienCam>0?Math.min(100,(Math.max(0,benefCamCum)/dTotalEntretienCam)*100):100;
const benefCamAffiche=dTotalEntretienCam>0&&resteCam>0?0:Math.max(0,benefCamCum)-dTotalEntretienCam;
// --- Bénéfice total chauffeur ---
const dBenefAffiche=(dTotalEntretienMach>0||dTotalEntretienCam>0)?(benefMachAffiche+benefCamAffiche):benefDay;
const dMarginPct=(totalRevDay>0)?((dBenefAffiche/totalRevDay)*100):0;
jobCalcs.forEach(c=>{c.marginPct=dMarginPct;c.benefAffiche=dBenefAffiche});
// Render each mission as a compact block
const allMissions=[...jobCalcs];
return(
<React.Fragment key={eId}>
{depotJobs.map(dj=>{const dep=getDepot(dj.depotId);return(
<div key={dj.id} style={{background:'#f8fafc',borderRadius:8,marginBottom:8,border:'1px solid '+C.border,borderLeft:'4px solid #64748b',padding:'8px 12px'}}>
<div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
<span style={{fontSize:15,fontWeight:700,color:'#64748b'}}>&#127959; {emp.name} — {dep?dep.name:'Depot'} — {dj.depotActivity||'Depot'}</span>
{dj.depotDescription&&<span style={{fontSize:14,color:C.dim}}>({dj.depotDescription})</span>}
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(x=>x.id!==dj.id);save(nd)}} style={{marginLeft:'auto',background:'none',border:'none',cursor:'pointer',fontSize:16,color:C.red}}>x</button>
</div>
<div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginTop:4,fontSize:13}}>
<span style={{color:C.dim}}>reel {mainTE&&mainTE.startTime?<b style={{color:C.accent}}>{mainTE.startTime}</b>:'--:--'}{'→'}{mainTE&&mainTE.endTime?<b style={{color:C.accent}}>{mainTE.endTime}</b>:'--:--'}</span>
{workMin>0&&<span style={{fontWeight:700,color:C.accent}}>{fmtDuration(workMin)}</span>}
{mainTE&&mainTE.requestedEndTime&&<span title={mainTE.requestedEndMotif?'Motif : '+mainTE.requestedEndMotif:'RDV / debauche demandee'} style={{padding:'1px 6px',borderRadius:10,fontSize:11,fontWeight:700,background:'#d9770630',color:'#d97706',maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'inline-block'}}>Deb. {mainTE.requestedEndTime}{mainTE.requestedEndMotif?' · '+mainTE.requestedEndMotif:''}</span>}
{mainTE&&mainTE.absenceType&&<span title={mainTE.requestedEndMotif&&mainTE.requestedEndMotif!==mainTE.absenceType?'Motif : '+mainTE.requestedEndMotif:mainTE.absenceType} style={{padding:'1px 6px',borderRadius:10,fontSize:11,fontWeight:700,background:C.red+'20',color:C.red,maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'inline-block'}}>{mainTE.absenceType}{mainTE.requestedEndMotif&&mainTE.requestedEndMotif!==mainTE.absenceType?' · '+mainTE.requestedEndMotif:''}</span>}
</div>
</div>)})}
{allMissions.length===0&&depotJobs.length===0&&(()=>{const defMach=getMach(emp.machineId);const machColor2=defMach?widthColor(defMach):C.muted;
const createJobForEmp=(field,value)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const newJ={id:uid(),date:selDate,employeeId:eId,machineId:emp.machineId||'',clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false};newJ[field]=value;nd.jobs.push(newJ);save(nd)};
return(
<div onDragOver={e2=>{if(dragJobId){e2.preventDefault();e2.stopPropagation();if(eId!==dragJobOverEmp)setDragJobOverEmp(eId)}}} onDrop={e2=>{if(dragJobId)onJobDrop(e2,eId)}} style={{background:C.card,borderRadius:10,marginBottom:12,marginTop:showSep?28:0,border:'3px solid '+(dragJobOverEmp===eId?C.cyan+'CC':machColor2),borderLeft:'6px solid '+machColor2,overflow:'hidden',boxShadow:'0 2px 6px rgba(0,0,0,.06)',display:'flex'}}>
{/* Côté gauche : nom employé + bouton "+" + nom machine + stats */}
<div style={{width:95,minWidth:95,maxWidth:95,padding:'10px 6px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:'2px solid '+machColor2+'20',background:machColor2+'08',gap:4}}>
<div style={{display:'flex',alignItems:'center',gap:4,justifyContent:'center'}}>
<div style={{fontSize:15,fontWeight:800,color:C.text,textAlign:'center',lineHeight:'1.2'}}>{emp.name}</div>
<button onClick={e=>{e.stopPropagation();const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:eId,machineId:emp.machineId||'',clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd)}} title="Ajouter un chantier" style={{background:machColor2,color:'#fff',border:'none',borderRadius:4,width:20,height:20,cursor:'pointer',fontSize:14,fontWeight:700,lineHeight:'18px',padding:0,flexShrink:0}}>+</button>
</div>
{defMach&&<div style={{fontSize:13,fontWeight:700,color:machColor2,textAlign:'center',lineHeight:'1.2'}}>{defMach.name}</div>}
{(()=>{const dowN=new Date(selDate).getDay();const dfmN=dowN===0?6:dowN-1;const monN=new Date(selDate);monN.setDate(monN.getDate()-dfmN);const monISO=fmtDateISO(monN);const wkTEs=(data.timeEntries||[]).filter(te2=>te2.empId===eId&&te2.date>=monISO&&te2.date<=selDate);const wkDates=[...new Set(wkTEs.filter(te2=>te2.startTime&&te2.endTime).map(te2=>te2.date))];const weekMin=wkDates.reduce((s,d)=>{const best=wkTEs.find(te2=>te2.date===d&&te2.startTime&&te2.endTime);return s+(best?calcWorkedMin(best):0)},0);const dayMin=(mainTE&&mainTE.startTime&&mainTE.endTime)?calcWorkedMin(mainTE):workMin;if(dayMin<=0&&weekMin<=0)return null;return(<div style={{fontSize:11,color:C.dim,textAlign:'center',marginTop:2,lineHeight:1.3,background:'#f1f5f9',borderRadius:6,padding:'3px 4px',width:'100%'}}><div>J <b style={{color:C.accent,fontSize:12}}>{fmtDuration(dayMin)}</b></div><div>S <b style={{color:C.accent,fontSize:12}}>{fmtDuration(weekMin)}</b></div></div>)})()}
</div>
{/* Côté droit : ligne placeholder pour saisie chantier (atténuée tant qu'aucun chantier n'a été créé) */}
<div style={{flex:1,minWidth:0}}>
<div style={{padding:'6px 10px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap',opacity:0.5}}>
<input list="planning-clients-list" placeholder="Client" onChange={e=>{const v=e.target.value;const matched=(data.clients||[]).find(c2=>c2.name===v);if(matched){createJobForEmp('clientId',matched.id);e.target.value=''}}} onBlur={e=>{const v=e.target.value.trim();if(!v)return;const matched=(data.clients||[]).find(c2=>c2.name.toLowerCase()===v.toLowerCase());if(matched){createJobForEmp('clientId',matched.id);e.target.value='';return}const nd=JSON.parse(JSON.stringify(data));if(!nd.clients)nd.clients=[];const nc={id:uid(),name:v,forfaitType:'standard',agencies:[],siteManagers:[]};nd.clients.push(nc);if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:eId,machineId:emp.machineId||'',clientId:nc.id,agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd);e.target.value=''}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:100,maxWidth:150}}/>
<select disabled style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#f8fafc',minWidth:80,maxWidth:130,color:C.dim}}><option>Chef</option></select>
<input placeholder="Lieu / adresse" onKeyDown={e=>{if(e.key==='Enter'&&e.target.value){createJobForEmp('location',e.target.value);e.target.value=''}}} style={{fontSize:15,padding:'4px 8px',borderRadius:6,border:'1px solid '+C.border,minWidth:100,flex:1,maxWidth:220,background:'#fff'}}/>
<input type="time" disabled value="08:00" style={{fontSize:15,padding:'4px 4px',borderRadius:6,border:'2px solid '+C.orange+'40',background:C.orange+'08',color:C.orange,fontWeight:700,width:75,opacity:0.5}}/>
<button onClick={()=>{setDepotFormEmpId(eId);setShowDepotForm(true)}} style={{background:'#64748b',color:'#fff',border:'none',borderRadius:4,padding:'4px 10px',cursor:'pointer',fontSize:13,marginLeft:'auto'}}>Dépôt</button>
</div>
{(te.length>0)&&<div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',padding:'4px 10px',fontSize:13,borderTop:'1px solid '+C.border,background:'#fafbfc'}}>
<span style={{color:C.dim}}>reel {mainTE&&mainTE.startTime?<b style={{color:C.accent}}>{mainTE.startTime}</b>:'--:--'}{'→'}{mainTE&&mainTE.endTime?<b style={{color:C.accent}}>{mainTE.endTime}</b>:'--:--'}</span>
{workMin>0&&<span style={{fontWeight:700,color:C.accent}}>{fmtDuration(workMin)}</span>}
{mainTE&&mainTE.requestedEndTime&&<span title={mainTE.requestedEndMotif?'Motif : '+mainTE.requestedEndMotif:'RDV / debauche demandee'} style={{padding:'1px 6px',borderRadius:10,fontSize:11,fontWeight:700,background:'#d9770630',color:'#d97706',maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'inline-block'}}>Deb. {mainTE.requestedEndTime}{mainTE.requestedEndMotif?' · '+mainTE.requestedEndMotif:''}</span>}
{mainTE&&mainTE.absenceType&&<span title={mainTE.requestedEndMotif&&mainTE.requestedEndMotif!==mainTE.absenceType?'Motif : '+mainTE.requestedEndMotif:mainTE.absenceType} style={{padding:'1px 6px',borderRadius:10,fontSize:11,fontWeight:700,background:C.red+'20',color:C.red,maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'inline-block'}}>{mainTE.absenceType}{mainTE.requestedEndMotif&&mainTE.requestedEndMotif!==mainTE.absenceType?' · '+mainTE.requestedEndMotif:''}</span>}
</div>}
</div>
</div>)})()}
{allMissions.length>0&&(()=>{const machGroups={};allMissions.forEach(mc=>{const mid=mc.m?mc.m.id:'none';if(!machGroups[mid])machGroups[mid]={m:mc.m,mt:mc.mt,missions:[]};machGroups[mid].missions.push(mc)});return Object.values(machGroups).map((grp,grpIdx)=>{const machColor=grp.m?widthColor(grp.m):C.accent;const allAck=grp.missions.every(mc2=>mc2.j.ack);return(
<div key={eId+'_'+(grp.m?grp.m.id:'none')} onDragOver={e2=>{e2.preventDefault();if(dragJobId){if(eId!==dragJobOverEmp)setDragJobOverEmp(eId)}else if(dragId&&cardId!==dragId){setDragOverId(cardId)}}} onDrop={e2=>{if(dragJobId)onJobDrop(e2,eId)}} style={{background:allAck?'#dcfce7':C.card,borderRadius:10,marginBottom:12,marginTop:(showSep&&grpIdx===0)?28:0,border:'3px solid '+(dragJobOverEmp===eId?C.cyan+'CC':dragOverId===cardId?C.accent+'80':allAck?'#16a34a':machColor),borderLeft:'6px solid '+(allAck?C.green:machColor),boxShadow:'0 2px 6px rgba(0,0,0,.06)',display:'flex',opacity:dragId===cardId?0.5:1}}>
{/* Côté gauche: nom + bouton "+" sur la même ligne, machine en dessous (draggable pour réordonner machines) */}
<div draggable onDragStart={e2=>onDragStart(e2,cardId)} onDragEnd={onDragEnd} style={{width:95,minWidth:95,maxWidth:95,padding:'10px 6px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',borderRight:'2px solid '+(allAck?'#16a34a20':machColor+'20'),background:machColor+'08',gap:4,cursor:'grab',borderTopLeftRadius:7,borderBottomLeftRadius:7}}>
<div style={{display:'flex',alignItems:'center',gap:4,justifyContent:'center'}}>
<div style={{fontSize:15,fontWeight:800,color:C.text,textAlign:'center',lineHeight:'1.2'}}>{emp.name}</div>
<button onClick={e=>{e.stopPropagation();const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];nd.jobs.push({id:uid(),date:selDate,employeeId:eId,machineId:grp.m?grp.m.id:emp.machineId||'',clientId:'',agencyName:'',siteManager:'',siteManagerPhone:'',location:'',gps:'',forfaitType:'',priceForfait:0,isNight:false,hasTransfer:false,transferPrice:0,billingStart:'08:00',startFrom:'',endAt:'',machineFuelL:0,machineFuelDepot:'',kmAller:0,kmRetour:0,travelMinAller:0,travelMinRetour:0,distanceKm:0,travelMin:0,sent:false});save(nd)}} title="Ajouter un chantier" style={{background:machColor,color:'#fff',border:'none',borderRadius:4,width:20,height:20,cursor:'pointer',fontSize:14,fontWeight:700,lineHeight:'18px',padding:0,flexShrink:0}}>+</button>
</div>
<div style={{fontSize:13,fontWeight:700,color:machColor,textAlign:'center',lineHeight:'1.2'}}>{grp.m?grp.m.name:'?'}</div>
{(()=>{const dowN=new Date(selDate).getDay();const dfmN=dowN===0?6:dowN-1;const monN=new Date(selDate);monN.setDate(monN.getDate()-dfmN);const monISO=fmtDateISO(monN);const wkTEs=(data.timeEntries||[]).filter(te2=>te2.empId===eId&&te2.date>=monISO&&te2.date<=selDate);const wkDates=[...new Set(wkTEs.filter(te2=>te2.startTime&&te2.endTime).map(te2=>te2.date))];const weekMin=wkDates.reduce((s,d)=>{const best=wkTEs.find(te2=>te2.date===d&&te2.startTime&&te2.endTime);return s+(best?calcWorkedMin(best):0)},0);const dayMin=(mainTE&&mainTE.startTime&&mainTE.endTime)?calcWorkedMin(mainTE):workMin;if(dayMin<=0&&weekMin<=0)return null;return(<div style={{fontSize:11,color:C.dim,textAlign:'center',marginTop:2,lineHeight:1.3,background:'#f1f5f9',borderRadius:6,padding:'3px 4px',width:'100%'}}><div>J <b style={{color:C.accent,fontSize:12}}>{fmtDuration(dayMin)}</b></div><div>S <b style={{color:C.accent,fontSize:12}}>{fmtDuration(weekMin)}</b></div></div>)})()}
{isMonthly&&<div style={{fontSize:11,color:C.dim,textAlign:'center'}}>{fmtMoney(dailySalary)}/j</div>}
</div>
{/* Côté droit: lignes de chantiers */}
<div style={{flex:1,minWidth:0}}>
{/* Ligne heures (visible uniquement si details d'au moins une mission ouverts) */}
{grp.missions.some(mc=>openDetails[mc.j.id])&&<div style={{padding:'4px 10px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap',borderBottom:'1px solid '+C.border,fontSize:12}}>
{(()=>{
const ji0=grp.missions[0]?grp.missions[0].j:null;
const th0=ji0?calcTheoreticalTimes(ji0,data,pMinGlobal):null;
const jdR=grp.m?jdReports.find(r=>r.jd_id===normJd(grp.m.name)||(grp.m.jdId&&r.jd_id===normJd(grp.m.jdId))):null;
let finChantier=null,arrDepot=null;
if(ji0&&ji0.billingStart&&jdR&&(jdR.working_h!=null||jdR.idle_h!=null)){
const[bh,bm]=ji0.billingStart.split(':').map(Number);
const tpArr=(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const trajR=Number(ji0.travelMinRetour)||0;
const fcMin=(bh*60+bm)+Math.round(((jdR.working_h||0)+(jdR.idle_h||0))*60);
finChantier=pad2(Math.floor(fcMin/60)%24)+':'+pad2(fcMin%60);
const adMin=fcMin+trajR+tpArr;
arrDepot=pad2(Math.floor(adMin/60)%24)+':'+pad2(adMin%60);
}
const coup=mainTE?mainTE.breakStart||mainTE.pauseStart||null:null;
const repr=mainTE?mainTE.breakEnd||mainTE.pauseEnd||null:null;
let breakMin=mainTE?Number(mainTE.pauseMin)||0:0;
if(coup&&repr){const[ch,cm]=coup.split(':').map(Number);const[rh,rm]=repr.split(':').map(Number);const bm2=(rh*60+rm)-(ch*60+cm);if(bm2>0)breakMin=bm2}
let debDem=null;
if(mainTE&&mainTE.startTime){const[sh,sm]=mainTE.startTime.split(':').map(Number);const dm=(sh*60+sm)+480+breakMin;debDem=pad2(Math.floor(dm/60)%24)+':'+pad2(dm%60)}
const Y=t=><span style={{background:'#fef9c3',border:'1px solid #eab308',borderRadius:6,padding:'2px 7px',color:'#713f12',fontWeight:700}}>{t}</span>;
const G=t=><span style={{background:'#dcfce7',border:'1px solid #16a34a',borderRadius:6,padding:'2px 7px',color:'#14532d',fontWeight:700}}>{t}</span>;
const B=t=><span style={{background:'#dbeafe',border:'1px solid #3b82f6',borderRadius:6,padding:'2px 7px',color:'#1e3a8a',fontWeight:700}}>{t}</span>;
const O=t=><span style={{background:'#fed7aa',border:'1px solid #f97316',borderRadius:6,padding:'2px 7px',color:'#9a3412',fontWeight:700}}>{t}</span>;
// Jour : calculé depuis mainTE uniquement (évite double-comptage)
const jourMin=(mainTE&&mainTE.startTime&&mainTE.endTime)?calcWorkedMin(mainTE):workMin;
// Semaine depuis lundi (corrigé : empId)
const dowN=new Date(selDate).getDay();const dfmN=dowN===0?6:dowN-1;const monN=new Date(selDate);monN.setDate(monN.getDate()-dfmN);const monISO=fmtDateISO(monN);
const wkTEs=(data.timeEntries||[]).filter(te=>te.empId===eId&&te.date>=monISO&&te.date<=selDate);
const wkDates=[...new Set(wkTEs.filter(te=>te.startTime&&te.endTime).map(te=>te.date))];
const wkMin=wkDates.reduce((s,d)=>{const best=wkTEs.find(te=>te.date===d&&te.startTime&&te.endTime);return s+(best?calcWorkedMin(best):0)},0);
// Timeline triée chronologiquement (endTime = carré 2 séparé)
const toM=t=>{if(!t)return 9999;const[h,m]=t.split(':').map(Number);return h*60+m};
const tItems=[];
if(mainTE&&mainTE.startTime)tItems.push({t:toM(mainTE.startTime),k:'emb',jsx:Y(mainTE.startTime)});
if(th0)tItems.push({t:toM(th0.theoStart),k:'dem',jsx:G('Dem. '+th0.theoStart)});
if(ji0&&ji0.billingStart)tItems.push({t:toM(ji0.billingStart),k:'ch',jsx:B('Ch. '+ji0.billingStart)});
if(finChantier)tItems.push({t:toM(finChantier),k:'fin',jsx:B('Fin '+finChantier)});
if(coup)tItems.push({t:toM(coup),k:'coup',jsx:Y('Coup. '+coup)});
if(repr)tItems.push({t:toM(repr),k:'repr',jsx:Y('Repr. '+repr)});
if(!coup&&breakMin>0)tItems.push({t:9000,k:'coup',jsx:Y('Pause '+fmtDuration(breakMin))});
if(debDem)tItems.push({t:toM(debDem),k:'debdem',jsx:G('Deb. '+debDem)});
if(arrDepot)tItems.push({t:toM(arrDepot),k:'dep',jsx:O('Dep. '+arrDepot)});
tItems.sort((a,b)=>a.t-b.t);
return(<React.Fragment>
{/* Carré 1 : heures jour + semaine */}
{(mainTE||workMin>0)&&<span style={{background:'#e0f2fe',border:'2px solid #0891b2',borderRadius:8,padding:'3px 10px',color:'#0c4a6e',fontWeight:800,whiteSpace:'nowrap',marginRight:4}}>{'⏱ '+fmtDuration(jourMin)+(wkMin>0?' | Sem '+fmtDuration(wkMin):'')}</span>}
{tItems.map(i=><React.Fragment key={i.k}>{i.jsx}</React.Fragment>)}
{/* Carré 2 : debauche réelle pointée (séparé à droite) */}
{mainTE&&mainTE.endTime&&<React.Fragment><span style={{color:C.muted,margin:'0 4px',fontWeight:300}}>|</span><span style={{background:'#fef9c3',border:'2px solid #eab308',borderRadius:8,padding:'3px 10px',color:'#713f12',fontWeight:800,whiteSpace:'nowrap'}}>{'↙ Deb. '+mainTE.endTime}</span></React.Fragment>}
{mainTE&&mainTE.absenceType&&<span title={mainTE.requestedEndMotif&&mainTE.requestedEndMotif!==mainTE.absenceType?'Motif : '+mainTE.requestedEndMotif:mainTE.absenceType} style={{padding:'2px 7px',borderRadius:6,fontWeight:700,background:C.red+'20',color:C.red,border:'1px solid '+C.red+'40',maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'inline-block',verticalAlign:'middle'}}>{mainTE.absenceType}{mainTE.requestedEndMotif&&mainTE.requestedEndMotif!==mainTE.absenceType?' · '+mainTE.requestedEndMotif:''}</span>}
</React.Fragment>);
})()}
</div>}
{/* Ligne Wirtgen résumé : intégrée dans le panneau détail de chaque mission */}
{grp.missions.map(({j,m,mt,fuelType,trajL,trajCost,machCost,salRoute,rev,cl,benefAffiche,marginPct})=>{
const theoJ=calcTheoreticalTimes(j,data,pMinGlobal);
const depName=j.startFrom==='home'?'Domicile':(getDepot(j.startFrom)||{}).name||((data.jobs||[]).find(jb=>jb.id===j.startFrom)?'← Chantier preced.':'');
const arrName=j.endAt==='home'?'Domicile':(getDepot(j.endAt)||{}).name||((data.jobs||[]).find(jb=>jb.id===j.endAt)?'→ Chantier suiv.':'');
return(
<div key={j.id} draggable onDragStart={e=>onJobDragStart(e,j.id)} onDragEnd={onJobDragEnd} style={{borderBottom:'1px solid '+C.border,background:j.isNight?'#fee2e2':j.ack?'#dcfce7':C.card,opacity:dragJobId===j.id?0.4:1,cursor:dragJobId===j.id?'grabbing':'grab'}}>
<div style={{padding:'6px 10px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.sent=!jj.sent;save(nd)}}} title={j.sent?'Chantier envoye au chauffeur':'Envoyer chantier au chauffeur'} style={{width:24,height:24,borderRadius:6,border:'2px solid '+(j.sent?C.green:C.muted),background:j.sent?C.green:'transparent',color:'#fff',cursor:'pointer',fontSize:14,fontWeight:800,padding:0,lineHeight:1,flexShrink:0}}>{j.sent?'✓':''}</button>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.paid=!jj.paid;save(nd)}}} title={j.paid?'Client a paye':'Marquer client paye'} style={{width:24,height:24,borderRadius:6,border:'2px solid '+(j.paid?C.purple:C.muted),background:j.paid?C.purple:'transparent',color:'#fff',cursor:'pointer',fontSize:13,fontWeight:800,padding:0,lineHeight:1,flexShrink:0}}>{j.paid?'€':''}</button>
<input key={'jcl_'+j.id+'_'+(j.clientId||'_')} list="planning-clients-list" placeholder="Client" defaultValue={cl?cl.name:''} onChange={e=>{const v=e.target.value;const matched=(data.clients||[]).find(c2=>c2.name===v);if(!matched)return;const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(!jj)return;jj.clientId=matched.id;const m3=getMach(jj.machineId);if(m3&&jj.forfaitType){const p=getForfaitPrice(nd,matched.id,m3,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}} onBlur={e=>{const v=e.target.value.trim();const exists=(data.clients||[]).find(c2=>c2.name.toLowerCase()===v.toLowerCase());if(exists){if(j.clientId!==exists.id){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.clientId=exists.id;const m3=getMach(jj.machineId);if(m3&&jj.forfaitType){const p=getForfaitPrice(nd,exists.id,m3,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}}return}if(!v){if(j.clientId){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.clientId='';save(nd)}}return}const nd=JSON.parse(JSON.stringify(data));if(!nd.clients)nd.clients=[];const nc={id:uid(),name:v,forfaitType:'standard',agencies:[],siteManagers:[]};nd.clients.push(nc);const jj=nd.jobs.find(x=>x.id===j.id);if(jj)jj.clientId=nc.id;save(nd)}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'2px solid '+(j.paid?C.purple:C.border),background:j.paid?C.purple+'20':'#fff',color:j.paid?C.purple:'inherit',fontWeight:j.paid?700:400,minWidth:100,maxWidth:150}}/>
{cl&&(cl.agencies||[]).length>0&&<select value={j.agencyName||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.agencyName=e.target.value;save(nd)}}} title={j.agencyName?'Agence : '+j.agencyName:'Choisir une agence'} style={{fontSize:13,padding:'4px 4px',borderRadius:6,border:'1px solid '+C.border,background:j.agencyName?'#eff6ff':'#fff',color:j.agencyName?'#1d4ed8':C.dim,fontWeight:j.agencyName?700:400,width:80,maxWidth:90,flexShrink:0}}><option value="">Agence</option>{(cl.agencies||[]).map((a,i)=><option key={i} value={a}>{a}</option>)}</select>}
<select value={j.siteManager||''} onChange={e=>{if(e.target.value==='__new__'){const n=prompt('Nouveau chef chantier'+(j.agencyName?' (agence : '+j.agencyName+')':'')+' :');if(n){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.siteManager=n;const cl2=(nd.clients||[]).find(c2=>c2.id===j.clientId);if(cl2){if(!cl2.siteManagers)cl2.siteManagers=[];if(!cl2.siteManagers.find(s=>s.name===n&&(s.agency||'')===(j.agencyName||''))){const ph=prompt('Tel du chef (optionnel):','')||'';cl2.siteManagers.push({name:n,phone:ph,agency:j.agencyName||''});jj.siteManagerPhone=ph}}save(nd)}}}else{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.siteManager=e.target.value;const cl2=(data.clients||[]).find(c2=>c2.id===j.clientId);const sm=(cl2&&cl2.siteManagers||[]).find(s=>s.name===e.target.value&&(!j.agencyName||!s.agency||s.agency===j.agencyName));if(sm)jj.siteManagerPhone=sm.phone||'';save(nd)}}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'1px solid '+C.border,background:'#fff',minWidth:80,maxWidth:130}}>
<option value="">Chef</option>{(cl&&cl.siteManagers||[]).filter(s=>!j.agencyName||!s.agency||s.agency===j.agencyName).map((s,si)=><option key={si} value={s.name}>{s.name}</option>)}<option value="__new__">+ Nouveau...</option>
</select>
<input value={j.location||''} placeholder="Lieu / adresse" onChange={e=>{const v=e.target.value;const tgt=e.target;const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.location=v;if(jj._geocodedGps)jj._geocodedGps='';save(nd)}triggerAutoGeocode(j.id,v,tgt)}} onFocus={e=>{if(j.location&&j.location.trim().length>=3&&!j._geocodedGps)triggerAutoGeocode(j.id,j.location,e.target)}} style={{fontSize:15,padding:'4px 8px',borderRadius:6,border:'1px solid '+(j._geocodedGps?C.green:C.border),minWidth:100,flex:1,maxWidth:220,background:j._geocodedGps?'#dcfce7':'#fff'}}/>
<input value={j.gps||''} placeholder="📍" title={j.gps?'GPS : '+j.gps+' (cliquer pour modifier)':'Coller le GPS ici (ex: 45.7128,-0.6234)'} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.gps=e.target.value;save(nd)}}} style={{fontSize:13,padding:'4px 4px',borderRadius:6,border:'2px solid '+(j.gps?C.green:C.border),background:j.gps?'#dcfce7':'#fff',width:42,flexShrink:0,textAlign:'center'}}/>
<input type="time" value={j.billingStart||'08:00'} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.billingStart=e.target.value;save(nd)}}} style={{fontSize:15,padding:'4px 4px',borderRadius:6,border:'2px solid '+C.orange+'40',background:C.orange+'08',color:C.orange,fontWeight:700,width:75}}/>
{/* GPS chantier + selects depart/arrivee deplaces dans le panneau detail (▼) */}
{/* Auto-init dep/arr quand l'utilisateur saisit le GPS (effet toujours actif meme si detail ferme) */}
{(()=>{const gpsJ=parseCoords(j.gps||j._geocodedGps);if(!gpsJ)return null;const empCo2=getEmpCoords(data,j.employeeId);const depOptions2=[{id:'home',name:'Dom.',co:empCo2},...(data.depots||[]).map(d2=>({id:d2.id,name:d2.name,co:d2._coords?parseCoords(typeof d2._coords==='string'?d2._coords:d2._coords.join(',')):null}))].map(o=>({...o,km:o.co&&gpsJ?+(haversine(o.co,gpsJ)*1.3).toFixed(0):null}));const arrOptions2=depOptions2.map(o=>({...o,km:o.co&&gpsJ?+(haversine(gpsJ,o.co)*1.3).toFixed(0):null}));const validDep=depOptions2.filter(o=>o.km!==null);const validArr=arrOptions2.filter(o=>o.km!==null);const shortDep=validDep.length>0?validDep.reduce((mn,o)=>o.km<mn.km?o:mn,validDep[0]):null;const shortArr=validArr.length>0?validArr.reduce((mn,o)=>o.km<mn.km?o:mn,validArr[0]):null;
setTimeout(()=>{const nd2=JSON.parse(JSON.stringify(data));const jj2=nd2.jobs.find(x=>x.id===j.id);if(!jj2)return;const empJobs=(nd2.jobs||[]).filter(jb=>jb.employeeId===jj2.employeeId&&jb.date===jj2.date&&jb.type!=='depot').sort((a,b)=>(a.billingStart||'99:99').localeCompare(b.billingStart||'99:99'));const myIdx=empJobs.findIndex(jb=>jb.id===jj2.id);const prevJob=myIdx>0?empJobs[myIdx-1]:null;const nextJob=myIdx>=0&&myIdx<empJobs.length-1?empJobs[myIdx+1]:null;const depotIds=new Set(['home',...(nd2.depots||[]).map(d=>d.id)]);const isDepotStart=!jj2.startFrom||depotIds.has(jj2.startFrom);const isDepotEnd=!jj2.endAt||depotIds.has(jj2.endAt);let changed=false;if(isDepotStart||(prevJob&&jj2.startFrom===prevJob.id)){const prevGps=prevJob?parseCoords(prevJob.gps||prevJob._geocodedGps):null;if(prevGps){const km=+(haversine(prevGps,gpsJ)*1.3*0.5).toFixed(0);if(jj2.startFrom!==prevJob.id||Math.abs((jj2.kmAller||0)-km)>=1){jj2.startFrom=prevJob.id;jj2.kmAller=km;jj2.travelMinAller=Math.round((km/80)*60);changed=true}}else if(isDepotStart&&!jj2.startFrom&&shortDep){jj2.startFrom=shortDep.id;jj2.kmAller=shortDep.km;jj2.travelMinAller=Math.round((shortDep.km/80)*60);changed=true}}if(isDepotEnd||(nextJob&&jj2.endAt===nextJob.id)){const nextGps=nextJob?parseCoords(nextJob.gps||nextJob._geocodedGps):null;if(nextGps){const km=+(haversine(gpsJ,nextGps)*1.3*0.5).toFixed(0);if(jj2.endAt!==nextJob.id||Math.abs((jj2.kmRetour||0)-km)>=1){jj2.endAt=nextJob.id;jj2.kmRetour=km;jj2.travelMinRetour=Math.round((km/80)*60);changed=true}}else if(isDepotEnd&&!jj2.endAt&&shortArr){jj2.endAt=shortArr.id;jj2.kmRetour=shortArr.km;jj2.travelMinRetour=Math.round((shortArr.km/80)*60);changed=true}}if(changed){jj2.distanceKm=(jj2.kmAller||0)+(jj2.kmRetour||0);jj2.travelMin=(jj2.travelMinAller||0)+(jj2.travelMinRetour||0);save(nd2)}},0)
return null;
})()}
<select value={j.forfaitType||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj&&m){jj.forfaitType=e.target.value;const p=getForfaitPrice(nd,j.clientId,m,e.target.value,j.citOption,j.isNight);if(p)jj.priceForfait=p;save(nd)}}} style={{fontSize:15,padding:'4px 6px',borderRadius:6,border:'2px solid '+(j.invoiced?'#eab308':j.forfaitType?FC[j.forfaitType]||C.accent:C.border),background:j.invoiced?'#fef9c3':j.forfaitType?(FC[j.forfaitType]||C.accent)+'15':'#fff',color:j.invoiced?'#713f12':j.forfaitType?FC[j.forfaitType]||C.accent:C.dim,fontWeight:j.forfaitType?700:400,minWidth:40}}>
<option value="">F</option>{(mt==='Citerne'?['Demi-journee','Journee']:['2h','4h','6h','8h']).map(f=><option key={f} value={f}>{f}</option>)}
</select>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj&&m){jj.hasTransfer=!jj.hasTransfer;if(jj.hasTransfer&&!jj.transferPrice){const tp=getTransferPrice(nd,j.clientId,m,j.citOption,j.isNight);jj.transferPrice=tp||0}save(nd)}}} style={{padding:'4px 8px',borderRadius:6,fontSize:14,border:'2px solid '+(j.invoiced&&j.hasTransfer?'#eab308':j.hasTransfer?C.purple:C.muted),background:j.invoiced&&j.hasTransfer?'#fef9c3':j.hasTransfer?C.purple+'20':'transparent',color:j.invoiced&&j.hasTransfer?'#713f12':j.hasTransfer?C.purple:C.dim,cursor:'pointer',fontWeight:j.hasTransfer?700:400}}>{j.hasTransfer?'T ✓':'+T'}</button>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.invoiced=!jj.invoiced;save(nd)}}} title={j.invoiced?'Facture envoyee':'Marquer facture envoyee'} style={{width:24,height:24,borderRadius:6,border:'2px solid '+(j.invoiced?'#eab308':C.muted),background:j.invoiced?'#eab308':'transparent',color:'#fff',cursor:'pointer',fontSize:14,fontWeight:800,padding:0,lineHeight:1,flexShrink:0}}>{j.invoiced?'✓':''}</button>
<div style={{marginLeft:'auto',display:'flex',gap:4,alignItems:'center'}}>
<div style={{position:'relative'}}><button onClick={e=>{e.stopPropagation();setAddEmpOpen(addEmpOpen===j.id?null:j.id)}} style={{padding:'3px 10px',borderRadius:6,fontSize:15,border:'2px solid '+C.cyan,background:addEmpOpen===j.id?C.cyan+'22':'transparent',color:C.cyan,cursor:'pointer',fontWeight:700,lineHeight:1}}>+</button>{addEmpOpen===j.id&&<div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'110%',right:0,zIndex:999,background:'#fff',border:'1px solid '+C.border,borderRadius:8,boxShadow:'0 4px 20px #0003',minWidth:160,overflow:'hidden'}}>{(data.employees||[]).filter(e2=>e2.id!==j.employeeId).map(e2=><div key={e2.id} onClick={()=>{const selEmp2=(data.employees||[]).find(x=>x.id===e2.id);const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const nj={...JSON.parse(JSON.stringify(j)),id:uid(),employeeId:e2.id,machineId:selEmp2?selEmp2.machineId||j.machineId:j.machineId,sent:false,ack:false};nd.jobs.push(nj);save(nd);setAddEmpOpen(null)}} style={{padding:'9px 14px',cursor:'pointer',fontSize:14,borderBottom:'1px solid #f1f5f9',color:C.text,userSelect:'none'}} onMouseEnter={e=>e.currentTarget.style.background='#f0f9ff'} onMouseLeave={e=>e.currentTarget.style.background=''}>{e2.name}</div>)}</div>}</div>
<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.isNight=!jj.isNight;if(jj.priceForfait&&jj.forfaitType&&m){const p=getForfaitPrice(nd,jj.clientId,m,jj.forfaitType,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}save(nd)}}} style={{padding:'3px 8px',borderRadius:6,fontSize:12,border:'2px solid '+(j.isNight?C.red:C.muted),background:j.isNight?C.red+'20':'transparent',color:j.isNight?C.red:C.dim,cursor:'pointer',fontWeight:j.isNight?700:400}}>Nuit</button>
<button onClick={()=>{setDupJobId(j.id);setDupDays(1)}} style={{background:'none',border:'2px solid #d97706',borderRadius:6,fontSize:12,cursor:'pointer',padding:'3px 6px',color:'#d97706',fontWeight:600}} title="Dupliquer sur plusieurs jours">D</button>
<button onClick={e=>{e.stopPropagation();setWirtgenTargetMach(grp.m?grp.m.name:'');if(wirtgenRef.current)wirtgenRef.current.click()}} title="Importer ZIP Wirtgen pour ce chantier" style={{background:'#fff7ed',color:'#9a3412',border:'2px solid #f97316',borderRadius:6,padding:'3px 7px',cursor:'pointer',fontSize:13,fontWeight:700}}>📥</button>
<button onClick={e=>{e.stopPropagation();const mNorm=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');const machName=m?m.name:(grp.m?grp.m.name:'');const mr=(data.machineReports||[]).find(r=>mNorm(r.machineName)===mNorm(machName)&&r.date===j.date);const emp2=(data.employees||[]).find(x=>x.id===j.employeeId);const exp={exportedAt:new Date().toISOString(),chantier:j,client:cl||null,machine:m||grp.m||null,chauffeur:emp2?{id:emp2.id,name:emp2.name}:null,rapportWirtgen:mr||null};const blob=new Blob([JSON.stringify(exp,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='rapport_'+(machName||'chantier').replace(/\s/g,'_')+'_'+j.date+'.json';a.click();URL.revokeObjectURL(url)}} title="Exporter ce chantier + son rapport Wirtgen en JSON" style={{background:'none',border:'2px solid #0891b2',borderRadius:6,fontSize:13,cursor:'pointer',padding:'3px 7px',color:'#0891b2',fontWeight:700}}>📤</button>
<button onClick={()=>toggleDetail(j.id)} style={{background:'none',border:'2px solid '+C.border,borderRadius:6,fontSize:14,cursor:'pointer',padding:'4px 8px',color:C.dim,fontWeight:600}}>{openDetails[j.id]?'▲':'▼'}</button>
<button onClick={e=>{e.stopPropagation();if(confirm('Supprimer ?')){const nd=JSON.parse(JSON.stringify(data));nd.jobs=nd.jobs.filter(x=>x.id!==j.id);save(nd)}}} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:C.red,fontWeight:700}}>×</button>
</div>
</div>
{/* Wirtgen timeline par chantier (cache sauf details ouverts) */}
{openDetails[j.id]&&(()=>{const mNorm=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');const mrRaw=(data.machineReports||[]).find(r=>mNorm(r.machineName)===mNorm(grp.m?grp.m.name:'')&&r.date===selDate);if(!mrRaw)return null;const mr=recomputeWirtgenReport(mrRaw);
const mIdx=grp.missions.findIndex(mc=>mc.j.id===j.id);
const isFirst=mIdx===0;const isLast=mIdx===grp.missions.length-1;
const _allSites=mr.sites||[];
let site;
if(grp.missions.length===1&&_allSites.length>1){
  // 1 seul chantier saisi mais l'algo Wirtgen a decoupe en plusieurs zones (centroides distants).
  // On agrege : 1er depart depot / 1ere arrivee chantier / 1er debut fraisage -> dernier fin fraisage / dernier depart chantier / dernier retour depot.
  const _ws=_allSites.filter(s=>s&&s.workStart);const _we=_allSites.filter(s=>s&&s.workEnd);const _da=_allSites.filter(s=>s&&s.depotArrival);const _f=_allSites[0]||{};const _l=_allSites[_allSites.length-1]||{};
  site={centroid:_f.centroid,depotDepart:_f.depotDepart,siteArrival:_f.siteArrival,workStart:(_ws[0]||_f).workStart||null,workEnd:(_we[_we.length-1]||_l).workEnd||null,siteDeparture:_l.siteDeparture||null,depotArrival:(_da[_da.length-1]||_l).depotArrival||null,outboundPauses:_allSites.reduce((a,s)=>a.concat((s&&s.outboundPauses)||[]),[]),inboundPauses:_allSites.reduce((a,s)=>a.concat((s&&s.inboundPauses)||[]),[])};
}else{site=_allSites[mIdx];}
// Heures théoriques (calculées à partir du GPS chantier + dépôt sélectionné + heure début chantier)
// Inclut les temps préparation matin (tpDepart) et mise en sécurité soir (tpArrivee) configurés dans les réglages.
// Marge de 15 min avant le début de facturation pour préparer la machine sur le chantier.
const toMinT=t=>{if(!t)return null;const[h,m2]=t.split(':').map(Number);return h*60+m2};
const minToHHMMt=mn=>{const mm=((mn%1440)+1440)%1440;return String(Math.floor(mm/60)).padStart(2,'0')+':'+String(mm%60).padStart(2,'0')};
const tpDepT=(data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART);
const tpArrT=(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const MARGE_ARRIVEE_CHANTIER=15;
const billStartMinT=toMinT(j.billingStart);
const travelAllerT=Number(j.travelMinAller)||0;
const travelRetourT=Number(j.travelMinRetour)||0;
// Arr. chantier théo = heure début facturation - 15 min (préparation sur place)
const theoArrCh=billStartMinT!=null?billStartMinT-MARGE_ARRIVEE_CHANTIER:null;
// Dép. dépôt théo = heure d'arrivée chantier théo - trajet aller - temps préparation matin
const theoDep=theoArrCh!=null&&travelAllerT>0?theoArrCh-travelAllerT-tpDepT:null;
// Arr. dépôt théo = heure de DÉPART CHANTIER RÉELLE + trajet retour théo + marge (tpArrivee, réglable)
const siteDepMinT=site&&site.siteDeparture?toMinT(site.siteDeparture):null;
const theoArrDep=siteDepMinT!=null&&travelRetourT>0?siteDepMinT+travelRetourT+tpArrT:null;
const evts=[];
// Multi-chantiers : chaque mission map à son site (sites[mIdx]). Les depotDepart/Arrival sont per-site.
// Fallback sur mr.depotDepart/Arrival pour rapports legacy stockés sans depotDepart per-site.
const dDep=(site&&site.depotDepart)||(isFirst?mr.depotDepart:null);
const dArr=(site&&site.depotArrival)||(isLast?mr.depotArrival:null);
if(dDep)evts.push({icon:'🚛',lbl:'Dép. dépôt',t:dDep,theo:theoDep!=null?minToHHMMt(theoDep):null,bg:'#eff6ff',bd:'#3b82f6',tx:'#1d4ed8'});
// Pauses intermédiaires aller (chez l'employé, pause repos, etc.)
if(site&&site.outboundPauses)site.outboundPauses.forEach(p=>{const dh=Math.floor(p.durationMin/60),dm=p.durationMin%60;const dur=dh>0?dh+'h'+String(dm).padStart(2,'0'):dm+'min';evts.push({icon:'⏸',lbl:'Pause '+dur,t:p.startHhmm+'→'+p.endHhmm,bg:'#fefce8',bd:'#eab308',tx:'#713f12',gpsLink:'https://www.google.com/maps?q='+p.lat+','+p.lon})});
if(site&&site.siteArrival)evts.push({icon:'📍',lbl:'Arr. chantier',t:site.siteArrival,theo:theoArrCh!=null?minToHHMMt(theoArrCh):null,bg:'#f5f3ff',bd:'#8b5cf6',tx:'#6d28d9'});
if(site&&site.workStart)evts.push({icon:'⚙️',lbl:'Début fraisage',t:site.workStart,bg:'#f0fdf4',bd:'#22c55e',tx:'#15803d'});
if(site&&site.workEnd)evts.push({icon:'🏁',lbl:'Fin fraisage',t:site.workEnd,bg:'#fff7ed',bd:'#f97316',tx:'#c2410c'});
if(site&&site.siteDeparture)evts.push({icon:'🚛',lbl:'Dép. chantier',t:site.siteDeparture,bg:'#f5f3ff',bd:'#8b5cf6',tx:'#6d28d9'});
// Pauses intermédiaires retour (rare mais possible)
if(site&&site.inboundPauses)site.inboundPauses.forEach(p=>{const dh=Math.floor(p.durationMin/60),dm=p.durationMin%60;const dur=dh>0?dh+'h'+String(dm).padStart(2,'0'):dm+'min';evts.push({icon:'⏸',lbl:'Pause '+dur,t:p.startHhmm+'→'+p.endHhmm,bg:'#fefce8',bd:'#eab308',tx:'#713f12',gpsLink:'https://www.google.com/maps?q='+p.lat+','+p.lon})});
if(dArr)evts.push({icon:'🏠',lbl:'Arr. dépôt',t:dArr,theo:theoArrDep!=null?minToHHMMt(theoArrDep):null,bg:'#eff6ff',bd:'#3b82f6',tx:'#1d4ed8'});
if(!evts.length)return null;
const toM=t=>{if(!t)return 0;const[h,m2]=t.split(':').map(Number);return h*60+m2};
const alerts=[];
if(site&&site.workStart&&j.billingStart&&Math.abs(toM(j.billingStart)-toM(site.workStart))>30)alerts.push('⚠️ Ch. '+j.billingStart+' ≠ machine '+site.workStart);
if(isFirst&&mainTE&&mainTE.startTime&&mr.depotDepart&&Math.abs(toM(mainTE.startTime)-toM(mr.depotDepart))>30)alerts.push('⚠️ Emb. '+mainTE.startTime+' ≠ '+mr.depotDepart);
if(isLast&&mainTE&&mainTE.endTime&&mr.depotArrival&&Math.abs(toM(mainTE.endTime)-toM(mr.depotArrival))>30)alerts.push('⚠️ Déb. '+mainTE.endTime+' ≠ '+mr.depotArrival);
return(<div style={{padding:'6px 12px',display:'flex',alignItems:'center',gap:0,background:'#f8fafc',borderBottom:'1px solid #e2e8f0',flexWrap:'wrap',rowGap:4}}>
{evts.map((ev,i)=><React.Fragment key={i}>
{i>0&&<span style={{color:'#94a3b8',fontSize:18,margin:'0 4px',fontWeight:300,lineHeight:1,userSelect:'none'}}>→</span>}
<div style={{display:'inline-flex',flexDirection:'column',alignItems:'center',gap:1}}>
{ev.gpsLink?<a href={ev.gpsLink} target="_blank" rel="noopener" title="Voir sur Google Maps" style={{background:ev.bg,border:'1px solid '+ev.bd,borderRadius:8,padding:'3px 10px',color:ev.tx,fontWeight:800,fontSize:13,whiteSpace:'nowrap',letterSpacing:'0.2px',textDecoration:'none',cursor:'pointer'}}>{ev.icon} {ev.t}</a>:<span style={{background:ev.bg,border:'1px solid '+ev.bd,borderRadius:8,padding:'3px 10px',color:ev.tx,fontWeight:800,fontSize:13,whiteSpace:'nowrap',letterSpacing:'0.2px'}}>{ev.icon} {ev.t}</span>}
<span style={{fontSize:9,color:ev.tx,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.4px',opacity:0.8}}>{ev.lbl}</span>
{ev.theo&&(()=>{const realMin=toM(ev.t);const theoMin=toM(ev.theo);let delta=realMin-theoMin;if(delta<-720)delta+=1440;else if(delta>720)delta-=1440;const ad=Math.abs(delta);const tcol=ad<=5?'#16a34a':ad<=15?'#d97706':'#dc2626';const sign=delta>0?'+':'';return<span title={'Théorique : '+ev.theo+' (réel '+(delta===0?'pile à l\'heure':sign+delta+' min)')} style={{fontSize:9,color:tcol,fontWeight:700,whiteSpace:'nowrap',cursor:'help'}}>théo {ev.theo} ({sign}{delta}m)</span>})()}
</div>
</React.Fragment>)}
{alerts.map((a,ai)=><span key={ai} style={{marginLeft:10,background:'#fee2e2',border:'1px solid #ef4444',borderRadius:6,padding:'2px 8px',color:'#991b1b',fontWeight:700,fontSize:11,whiteSpace:'nowrap'}}>{a}</span>)}
</div>);})()}
{/* Details panel */}
{openDetails[j.id]&&<div style={{padding:'8px 12px',borderTop:'1px solid '+C.border,background:'#fafbfc'}}>
{(()=>{
// ========= NOUVEAU PANNEAU DÉTAIL : 8 événements théo/réel + 7 segments + bénéfice =========
const toMinD=t=>{if(!t)return null;const[h,m2]=t.split(':').map(Number);return h*60+m2};
const minToHHMMd=mn=>{if(mn==null||isNaN(mn))return '—';const mm=((mn%1440)+1440)%1440;return String(Math.floor(mm/60)).padStart(2,'0')+':'+String(mm%60).padStart(2,'0')};
const fmtMinD=mn=>{if(mn==null||isNaN(mn)||mn<0)return '—';if(mn<60)return mn+'min';return Math.floor(mn/60)+'h'+String(mn%60).padStart(2,'0')};
const tpDep=data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART;
const tpArr=data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE;
const MARGE=15;
const billMin=toMinD(j.billingStart);
const travelAller=Number(j.travelMinAller)||0;
const travelRetour=Number(j.travelMinRetour)||0;
const kmAller=Number(j.kmAller)||0;
const kmRetour=Number(j.kmRetour)||0;
const fhJob=forfaitHours(j.forfaitType);
const pMin=mainTE?(mainTE.pauseMin||0):0;
const mNorm=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');
const mrRaw=(data.machineReports||[]).find(r=>mNorm(r.machineName)===mNorm(m?m.name:'')&&r.date===selDate);
const mrD=mrRaw?recomputeWirtgenReport(mrRaw):null;
// Multi-chantiers : récupère le site correspondant à CETTE mission (par son index dans grp.missions)
const mIdxD=grp.missions.findIndex(mc=>mc.j.id===j.id);
const siteD=mrD?(mrD.sites||[])[mIdxD>=0?mIdxD:0]:null;
const truck=(data.trucks||[]).find(t=>emp&&t.id===emp.truckId);
const truckCons=truck?Number(truck.fuelPer100)||25:25;
const prixGazole=getFuelPrice(data,'gazole',j.startFrom!=='home'?j.startFrom:null);
const machineFuelType=m?getMachineFuelType(data,m.id):'gnr';
const prixMachineFuel=getFuelPrice(data,machineFuelType,j.machineFuelDepot);
// 8 heures théoriques
const T={
e:billMin!=null?billMin-MARGE-travelAller-tpDep:null,
dD:billMin!=null?billMin-MARGE-travelAller:null,
aC:billMin!=null?billMin-MARGE:null,
fS:billMin,
fE:billMin!=null?billMin+fhJob*60+pMin:null,
dC:billMin!=null?billMin+fhJob*60+pMin:null,
// Arr. Dépôt théo = heure de DÉPART CHANTIER RÉELLE + trajet retour théo (mieux que theo pur car
// reflète le vrai départ chantier, surtout si le chantier finit plus tot/tard que prévu)
aD:(()=>{const sd=siteD&&siteD.siteDeparture?toMinD(siteD.siteDeparture):null;return sd!=null&&travelRetour>0?sd+travelRetour:(billMin!=null?billMin+fhJob*60+pMin+travelRetour:null)})(),
// Débauche théo = Arr. Dépôt théo + tpArrivee (marge mise en sécurité, réglable dans les paramètres)
db:(()=>{const sd=siteD&&siteD.siteDeparture?toMinD(siteD.siteDeparture):null;return sd!=null&&travelRetour>0?sd+travelRetour+tpArr:(billMin!=null?billMin+fhJob*60+pMin+travelRetour+tpArr:null)})()
};
// 8 heures réelles
// Multi-chantiers : chaque mission utilise son site dédié, depotDepart/Arrival per-site
const dDepStr=siteD&&siteD.depotDepart?siteD.depotDepart:(mrD?mrD.depotDepart:null);
const dArrStr=siteD&&siteD.depotArrival?siteD.depotArrival:(mrD?mrD.depotArrival:null);
const R={
e:mainTE?toMinD(mainTE.startTime):null,
dD:dDepStr?toMinD(dDepStr):null,
aC:siteD?toMinD(siteD.siteArrival):null,
fS:siteD?toMinD(siteD.workStart):null,
fE:siteD?toMinD(siteD.workEnd):null,
dC:siteD?toMinD(siteD.siteDeparture):null,
aD:dArrStr?toMinD(dArrStr):null,
db:mainTE?toMinD(mainTE.endTime):null
};
const KEYS=['e','dD','aC','fS','fE','dC','aD','db'];
// Propage l'ajout +1440 min pour les events qui sont le LENDEMAIN (chantier de nuit qui dépasse minuit).
// Heuristique : si un event est < event précédent (= ordre temporel cassé), il est le lendemain.
let dayShift=0,prevR=null;
for(const k of KEYS){
  if(R[k]!=null){
    if(prevR!=null&&R[k]+dayShift<prevR)dayShift+=1440;
    R[k]+=dayShift;
    prevR=R[k];
  }
}
const LABELS=['Embauche','Départ','Arr. ch.','Début','Fin','Dép. ch.','Arr. dép.','Débauche'];
const SOURCES=['P','R','R','R','R','R','R','P'];
// 7 segments entre événements consécutifs
const segLabels=['Préparation','Trajet aller','Installation','Fraisage','Rangement','Trajet retour','Mise séc.'];
const segs=segLabels.map((lbl,i)=>{
const k1=KEYS[i],k2=KEYS[i+1];
const tT=T[k1]!=null&&T[k2]!=null?T[k2]-T[k1]:null;
const tR=R[k1]!=null&&R[k2]!=null?R[k2]-R[k1]:null;
const sT=tT!=null&&tT>=0?(tT/60)*hourly:null;
const sR=tR!=null&&tR>=0?(tR/60)*hourly:null;
let cT=null,cR=null,cPrice=prixGazole;
if(i===1){cT=(kmAller/100)*truckCons;cR=cT}
else if(i===5){cT=(kmRetour/100)*truckCons;cR=cT}
else if(i===3){cR=mrD?Number(mrD.fuelL)||0:null;cPrice=prixMachineFuel}
const ccT=cT!=null?cT*cPrice:null;
const ccR=cR!=null?cR*cPrice:null;
return{lbl,tT,tR,sT,sR,cT,cR,ccT,ccR};
});
const totalSalT=segs.reduce((s,sg)=>s+(sg.sT||0),0);
const totalSalR=segs.reduce((s,sg)=>s+(sg.sR||0),0);
const totalConsT=segs.reduce((s,sg)=>s+(sg.ccT||0),0);
const totalConsR=segs.reduce((s,sg)=>s+(sg.ccR||0),0);
const coutT=totalSalT+totalConsT;
const coutR=totalSalR+totalConsR;
const ca=(j.priceForfait||0)+(j.hasTransfer?(j.transferPrice||0):0);
const benefT=ca-coutT;
const benefR=ca-coutR;
// GPS chantier RÉEL = centroïde stocké directement dans le site (= moyenne des "On" moteur du cluster).
// Permet d'avoir un centroïde DIFFÉRENT par site pour les jours multi-chantiers.
let chantierGpsR=null,distFromUser=null;
if(siteD&&siteD.centroid){
  chantierGpsR={lat:siteD.centroid.lat,lon:siteD.centroid.lon};
  if(j.gps){const uc=parseCoords(j.gps);if(uc)distFromUser=haversine([uc[0],uc[1]],[chantierGpsR.lat,chantierGpsR.lon])*1000}
}else if(mrD&&mrD.rawPts&&siteD){
  // Fallback rapports legacy sans centroid stocké
  const sArr=toMinD(siteD.siteArrival)||0;
  const sDep=siteD.siteDeparture?toMinD(siteD.siteDeparture):(toMinD(siteD.workEnd)||0);
  const ptsIn=mrD.rawPts.filter(p=>p.min>=sArr&&p.min<=sDep);
  if(ptsIn.length){
    const lat=ptsIn.reduce((s,p)=>s+p.lat,0)/ptsIn.length;
    const lon=ptsIn.reduce((s,p)=>s+p.lon,0)/ptsIn.length;
    chantierGpsR={lat,lon};
    if(j.gps){const uc=parseCoords(j.gps);if(uc)distFromUser=haversine([uc[0],uc[1]],[lat,lon])*1000}
  }
}
return(<div style={{display:'flex',flexDirection:'column',gap:6,fontSize:11}}>
{/* Ligne -1 : GPS saisi + Dep + Arr (déplacés ici depuis la ligne chantier) */}
{(()=>{const gpsJ=parseCoords(j.gps||j._geocodedGps);const empCo2=getEmpCoords(data,j.employeeId);const depBase=[{id:'home',name:'Dom.',co:empCo2},...(data.depots||[]).map(d2=>({id:d2.id,name:d2.name,co:d2._coords?parseCoords(typeof d2._coords==='string'?d2._coords:d2._coords.join(',')):null}))];
// Voisins (autres chantiers du meme chauffeur le meme jour, tries par heure de facturation) → ajoutent une option 'chantier prec.' a Dep et 'chantier suiv.' a Arr.
const sortedEmpJobs=(data.jobs||[]).filter(jb=>jb.employeeId===j.employeeId&&jb.date===j.date&&jb.type!=='depot').sort((a,b)=>(a.billingStart||'99:99').localeCompare(b.billingStart||'99:99'));
const _myIdx=sortedEmpJobs.findIndex(x=>x.id===j.id);
const _prevJ=_myIdx>0?sortedEmpJobs[_myIdx-1]:null;
const _nextJ=_myIdx>=0&&_myIdx<sortedEmpJobs.length-1?sortedEmpJobs[_myIdx+1]:null;
const _jobOpt=(jb,arrow)=>{if(!jb)return null;const co=parseCoords(jb.gps||jb._geocodedGps);if(!co)return null;return{id:jb.id,name:arrow+' '+(jb.location||jb.billingStart||'chantier').slice(0,18),co,_isJob:true}};
const prevOpt=_jobOpt(_prevJ,'←');
const nextOpt=_jobOpt(_nextJ,'→');
const depOptions2=[...(prevOpt?[prevOpt]:[]),...depBase].map(o=>({...o,km:o.co&&gpsJ?+(haversine(o.co,gpsJ)*1.3*(o._isJob?0.5:1)).toFixed(0):null}));
const arrOptions2=[...(nextOpt?[nextOpt]:[]),...depBase].map(o=>({...o,km:o.co&&gpsJ?+(haversine(gpsJ,o.co)*1.3*(o._isJob?0.5:1)).toFixed(0):null}));
const validDep=depOptions2.filter(o=>o.km!==null);const validArr=arrOptions2.filter(o=>o.km!==null);const shortDep=validDep.length>0?validDep.reduce((mn,o)=>o.km<mn.km?o:mn,validDep[0]):null;const shortArr=validArr.length>0?validArr.reduce((mn,o)=>o.km<mn.km?o:mn,validArr[0]):null;
return(<div style={{display:'flex',alignItems:'center',gap:6,padding:'4px 8px',background:'#fff',border:'1px solid '+C.border,borderRadius:6,fontSize:11,flexWrap:'wrap'}}>
{/* Champ GPS saisi masqué : alimenté automatiquement via géocodage du lieu */}
<span style={{color:C.dim}}>↗ Dép :</span>
<select value={j.startFrom||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.startFrom=e.target.value;const sel2=depOptions2.find(o=>o.id===e.target.value);jj.kmAller=sel2&&sel2.km?sel2.km:0;jj.travelMinAller=sel2&&sel2.km?Math.round((sel2.km/80)*60):0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);jj.travelMin=(jj.travelMinAller||0)+(jj.travelMinRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 5px',borderRadius:4,border:'1px solid #0891b240',background:j.startFrom&&shortDep&&j.startFrom===shortDep.id?'#0891b218':'#0891b208',color:'#0891b2',fontWeight:600,minWidth:110,maxWidth:160}}>
<option value="">--</option>{depOptions2.map(o=>{const tm=o.km!==null?Math.round((o.km/80)*60):null;const tStr=tm!=null?(tm<60?tm+'min':Math.floor(tm/60)+'h'+String(tm%60).padStart(2,'0')):'';return<option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km · '+tStr:''}{shortDep&&o.id===shortDep.id?' ★':''}</option>})}
</select>
<span style={{color:C.dim,marginLeft:6}}>↙ Arr :</span>
<select value={j.endAt||''} onChange={e=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.endAt=e.target.value;const sel2=arrOptions2.find(o=>o.id===e.target.value);jj.kmRetour=sel2&&sel2.km?sel2.km:0;jj.travelMinRetour=sel2&&sel2.km?Math.round((sel2.km/80)*60):0;jj.distanceKm=(jj.kmAller||0)+(jj.kmRetour||0);jj.travelMin=(jj.travelMinAller||0)+(jj.travelMinRetour||0);save(nd)}}} style={{fontSize:12,padding:'2px 5px',borderRadius:4,border:'1px solid #7c3aed40',background:j.endAt&&shortArr&&j.endAt===shortArr.id?'#7c3aed18':'#7c3aed08',color:'#7c3aed',fontWeight:600,minWidth:110,maxWidth:160}}>
<option value="">--</option>{arrOptions2.map(o=>{const tm=o.km!==null?Math.round((o.km/80)*60):null;const tStr=tm!=null?(tm<60?tm+'min':Math.floor(tm/60)+'h'+String(tm%60).padStart(2,'0')):'';return<option key={o.id} value={o.id}>{o.name}{o.km!==null?' '+o.km+'km · '+tStr:''}{shortArr&&o.id===shortArr.id?' ★':''}</option>})}
</select>
</div>);
})()}
{/* Ligne 0 : GPS chantier réel (depuis rapport Wirtgen) */}
{chantierGpsR&&<div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 8px',background:'#fff',border:'1px solid '+C.border,borderRadius:6,fontSize:11,flexWrap:'wrap'}}>
<span style={{fontWeight:700,color:C.dim}}>📍 GPS chantier (rapport) :</span>
<a href={'https://www.google.com/maps?q='+chantierGpsR.lat+','+chantierGpsR.lon} target="_blank" rel="noopener" style={{color:'#1d4ed8',fontWeight:700,textDecoration:'none'}} title="Ouvrir dans Google Maps">{chantierGpsR.lat.toFixed(6)}, {chantierGpsR.lon.toFixed(6)}</a>
<button onClick={()=>{if(navigator.clipboard)navigator.clipboard.writeText(chantierGpsR.lat.toFixed(6)+','+chantierGpsR.lon.toFixed(6))}} style={{background:'#f1f5f9',border:'1px solid '+C.border,borderRadius:4,padding:'1px 6px',cursor:'pointer',fontSize:10,color:C.dim}} title="Copier les coordonnées">📋</button>
{j.gps&&distFromUser!=null&&(()=>{const col=distFromUser<=100?C.green:distFromUser<=500?C.orange:C.red;const ic=distFromUser<=100?'✓':distFromUser<=500?'⚠':'❌';return<span style={{color:col,fontWeight:700,fontSize:10}} title={'GPS saisi : '+j.gps}>{ic} {distFromUser<1000?Math.round(distFromUser)+'m':(distFromUser/1000).toFixed(1)+'km'} vs saisi</span>})()}
{!j.gps&&<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.gps=chantierGpsR.lat.toFixed(6)+','+chantierGpsR.lon.toFixed(6);save(nd)}}} style={{background:'#dcfce7',border:'1px solid #16a34a',borderRadius:4,padding:'1px 8px',cursor:'pointer',fontSize:10,color:'#14532d',fontWeight:700}}>↵ Enregistrer comme GPS chantier</button>}
{mrD&&mrD.rawPts&&mrD.rawPts.length&&<button onClick={()=>{setMapModal({title:(m?m.name:'')+' — '+(j.location||j.billingStart||''),rawPts:mrD.rawPts,centroid:siteD&&siteD.centroid,depotGps:mrD.rawPts[0],pauses:[...((siteD&&siteD.outboundPauses)||[]),...((siteD&&siteD.inboundPauses)||[])],siteArrival:siteD&&siteD.siteArrival,siteDeparture:siteD&&siteD.siteDeparture,workStart:siteD&&siteD.workStart,workEnd:siteD&&siteD.workEnd})}} style={{background:'#eff6ff',border:'1px solid #3b82f6',borderRadius:4,padding:'2px 10px',cursor:'pointer',fontSize:11,color:'#1d4ed8',fontWeight:700,marginLeft:'auto'}}>🗺 Voir trajet</button>}
</div>}
{/* 3 carres agreges : Transfert (trajet aller+retour), Chantier (= opH Wirtgen), Depot (debauche - arrivee depot - pause si apres) */}
{(()=>{
// Agregations de litres et couts conso (R) inchanges, basees sur segs
const aggLC=(idxs)=>{const r={cR:0,ccR:0};idxs.forEach(i=>{const sg=segs[i];if(!sg)return;if(sg.cR!=null)r.cR+=sg.cR;if(sg.ccR!=null)r.ccR+=sg.ccR});return r};
// 1. Transfert : trajet aller (segs[1]) + retour (segs[5])
let transfertTR=0;[1,5].forEach(i=>{const sg=segs[i];if(sg&&sg.tR!=null&&sg.tR>=0)transfertTR+=sg.tR});
const transfertLC=aggLC([1,5]);
// 2. Chantier : temps = opH du rapport Wirtgen (fraisage actif). Fallback sur segs[2]+[3]+[4] si rapport absent.
let chantierTR;
if(mrD&&mrD.opH!=null&&mrD.opH>0){chantierTR=Math.round(mrD.opH*60)}
else{chantierTR=0;[2,3,4].forEach(i=>{const sg=segs[i];if(sg&&sg.tR!=null&&sg.tR>=0)chantierTR+=sg.tR})}
const chantierLC=aggLC([2,3,4]);
// 3. Depot : preparation matin (segs[0]) + (debauche - arrivee depot - pause si pause apres arrivee depot)
const _aDr=(mrD&&mrD.depotArrival)?toMinD(mrD.depotArrival):(R['aD']!=null?R['aD']%1440:null);
const _dbr=(mainTE&&mainTE.endTime)?toMinD(mainTE.endTime):(R['db']!=null?R['db']%1440:null);
const _pStart=mainTE&&(mainTE.breakStart||mainTE.pauseStart)?toMinD(mainTE.breakStart||mainTE.pauseStart):null;
const _pEnd=mainTE&&(mainTE.breakEnd||mainTE.pauseEnd)?toMinD(mainTE.breakEnd||mainTE.pauseEnd):null;
const _pauseM=(_pStart!=null&&_pEnd!=null&&_pEnd>_pStart)?(_pEnd-_pStart):(mainTE&&mainTE.pauseMin?Number(mainTE.pauseMin):0);
let depotAfter=0;
if(_aDr!=null&&_dbr!=null){let dur=_dbr-_aDr;if(dur<-720)dur+=1440;if(dur<0)dur=0;if(_pStart!=null&&_pStart>=_aDr)dur-=_pauseM;depotAfter=Math.max(0,dur)}
const morningPrep=(segs[0]&&segs[0].tR!=null&&segs[0].tR>=0)?segs[0].tR:0;
let depotTR=morningPrep+depotAfter;
const depotLC=aggLC([0,6]);
// 4. Plafond 8h (480 min) sur la somme : on reduit le Depot en cas de depassement
const _max=480;
const _totR=transfertTR+chantierTR+depotTR;
if(_totR>_max){depotTR=Math.max(0,depotTR-(_totR-_max))}
const blocks=[
  {lbl:'Transfert',d:{tR:transfertTR,sR:(transfertTR/60)*hourly,...transfertLC},ca:j.hasTransfer?(j.transferPrice||0):0,color:'#d97706'},
  {lbl:'Chantier',d:{tR:chantierTR,sR:(chantierTR/60)*hourly,...chantierLC},ca:j.priceForfait||0,color:'#16a34a'},
  {lbl:'Depot',d:{tR:depotTR,sR:(depotTR/60)*hourly,...depotLC},ca:0,color:'#0891b2'}
];
blocks.forEach(b=>{b.cost=(b.d.sR||0)+(b.d.ccR||0);b.benef=b.ca-b.cost});
const totBenef=blocks.reduce((s,b)=>s+b.benef,0);
return(<React.Fragment>
<div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
{blocks.map((b,bi)=>(<div key={bi} style={{display:'flex',flexDirection:'column',gap:6}}>
  {/* Carre principal : Temps + couts detailles */}
  <div style={{background:'#fff',border:'2px solid '+b.color,borderRadius:10,overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 1px 3px rgba(0,0,0,.06)'}}>
    <div style={{background:b.color,color:'#fff',fontWeight:800,padding:'5px 10px',textAlign:'center',fontSize:13,textTransform:'uppercase',letterSpacing:'0.8px'}}>{b.lbl}</div>
    <div style={{padding:'12px 8px 10px',textAlign:'center',background:b.color+'08',flex:1,display:'flex',flexDirection:'column',justifyContent:'center'}}>
      <div style={{fontSize:24,fontWeight:800,color:b.color,lineHeight:1}}>{b.d.tR!=null?(b.d.tR>0?fmtMinD(b.d.tR):'0min'):'—'}</div>
      {b.d.cR>0&&<div style={{fontSize:12,color:C.dim,marginTop:4,fontWeight:600,display:'flex',alignItems:'center',justifyContent:'center',gap:6,flexWrap:'wrap'}}>
        <span>⛽ {b.d.cR.toFixed(1)} L</span>
        {bi<2&&(()=>{const isTransfert=bi===0;const fuelLbl=isTransfert?'Gazole':(machineFuelType==='gnr'?'GNR':'Gazole');const curPrice=isTransfert?prixGazole:prixMachineFuel;return<span style={{display:'inline-flex',alignItems:'center',gap:2}} title={'Prix '+fuelLbl+' (modifiable)'}>
          <input type="number" step="0.01" defaultValue={Number(curPrice).toFixed(3)} key={'fp_'+bi+'_'+curPrice} onBlur={e=>{const v=Number(e.target.value);if(!(v>0))return;if(Math.abs(v-curPrice)<0.001)return;const nd=JSON.parse(JSON.stringify(data));const depId=isTransfert?(j.startFrom&&j.startFrom!=='home'?j.startFrom:null):j.machineFuelDepot;if(depId){const dep=(nd.depots||[]).find(d=>d.id===depId);if(dep){if(isTransfert||machineFuelType==='gazole')dep.gazolePrice=v;else dep.gnrPrice=v;save(nd);return}}nd.fuelPrice=v;save(nd)}} style={{width:54,fontSize:11,padding:'1px 3px',borderRadius:3,border:'1px solid #cbd5e1',textAlign:'right',background:'#fff',fontWeight:700}}/>
          <span style={{fontSize:10}}>€/L {fuelLbl}</span>
        </span>})()}
      </div>}
    </div>
    <div style={{padding:'6px 8px',borderTop:'1px solid '+b.color+'33',background:'#fafbfc',display:'flex',justifyContent:'space-around',gap:6}}>
      {b.d.sR!=null&&<div style={{textAlign:'center',flex:1}}><div style={{fontSize:9,color:C.dim,textTransform:'uppercase',fontWeight:700,letterSpacing:'0.3px'}}>Salaire</div><div style={{fontWeight:800,color:'#15803d',fontSize:13}}>{fmtMoney(b.d.sR||0)}</div></div>}
      {b.d.ccR>0&&<div style={{textAlign:'center',flex:1,borderLeft:'1px dashed '+b.color+'40',paddingLeft:6}}><div style={{fontSize:9,color:C.dim,textTransform:'uppercase',fontWeight:700,letterSpacing:'0.3px'}}>Carburant</div><div style={{fontWeight:800,color:'#15803d',fontSize:13}}>{fmtMoney(b.d.ccR)}</div></div>}
    </div>
  </div>
  {/* Mini-card CA / Couts / Benefice */}
  <div style={{background:b.benef>=0?'#f0fdf4':'#fff1f2',border:'2px solid '+(b.benef>=0?'#86efac':'#fca5a5'),borderRadius:8,padding:'6px 10px'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:11,marginBottom:2}}>
      <span style={{color:C.dim}}>CA <b style={{color:'#1d4ed8'}}>{fmtMoney(b.ca)}</b></span>
      <span style={{color:C.dim}}>Couts <b style={{color:'#dc2626'}}>{fmtMoney(b.cost)}</b></span>
    </div>
    <div style={{textAlign:'center',fontSize:16,fontWeight:800,color:b.benef>=0?'#15803d':'#dc2626',lineHeight:1.1}}>
      {b.benef>=0?'+':''}{fmtMoney(b.benef)}
    </div>
  </div>
</div>))}
</div>
{/* Bandeau Benefice total tout en bas */}
<div style={{marginTop:8,padding:'10px 16px',background:totBenef>=0?'#15803d':'#dc2626',borderRadius:10,display:'flex',justifyContent:'space-between',alignItems:'center',color:'#fff',boxShadow:'0 2px 6px rgba(0,0,0,.15)'}}>
<span style={{fontWeight:800,fontSize:14,textTransform:'uppercase',letterSpacing:'0.8px'}}>📊 Benefice du chantier</span>
<span style={{fontSize:24,fontWeight:800}}>{totBenef>=0?'+':''}{fmtMoney(totBenef)}</span>
</div>
</React.Fragment>);
})()}
</div>);
})()}
{/* Bandeau Wirtgen + bouton 'Affecter au depot' (deplaces tout en bas du detail) */}
{(()=>{const mNorm=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');const mr=(data.machineReports||[]).find(r=>mNorm(r.machineName)===mNorm(grp.m?grp.m.name:'')&&r.date===selDate);if(!mr)return null;
return(<div style={{padding:'4px 8px',display:'flex',alignItems:'center',gap:5,flexWrap:'wrap',background:'#fefce8',fontSize:11,borderRadius:6,border:'1px solid #fde68a',marginTop:6}}>
<span style={{color:'#713f12',fontWeight:800,fontSize:11}}>⚙️ Wirtgen</span>
{mr.ehStart>0&&mr.ehEnd>mr.ehStart&&<span style={{background:'#f0f9ff',border:'1px solid #7dd3fc',borderRadius:5,padding:'1px 7px',color:'#0c4a6e',fontWeight:700}}>⏱ {mr.ehStart}h→{mr.ehEnd}h (+{mr.ehEnd-mr.ehStart}h moteur)</span>}
{mr.fuelL>0&&<span style={{background:'#fef3c7',border:'1px solid #f59e0b',borderRadius:5,padding:'1px 7px',color:'#92400e',fontWeight:700}}>⛽ {mr.fuelL}L</span>}
{mr.opH>0&&(()=>{const buckets=mr.opTimeBuckets||[];const sigBuckets=buckets.filter(b=>b.opH>=0.05);const tooltip=sigBuckets.length?'Détail fraisage par heure (heure locale) :\n'+sigBuckets.map(b=>{const h1=Math.floor(b.startMin/60),m1=b.startMin%60,h2=Math.floor(b.endMin/60),m2=b.endMin%60;const min=Math.round(b.opH*60);const power=b.powerPct!=null?' / '+b.powerPct+'% puiss.':'';const fuel=b.fuelL!=null?' / '+b.fuelL+'L':'';const rate=b.fuelRateLh!=null?' ('+b.fuelRateLh.toFixed(1)+' L/h)':'';const spd=b.speedKmh!=null?' / '+(b.speedKmh*1000/60).toFixed(1)+' m/min':'';const pres=b.pressureBar!=null?' / '+b.pressureBar.toFixed(0)+' bar':'';return String(h1).padStart(2,'0')+':'+String(m1).padStart(2,'0')+'-'+String(h2).padStart(2,'0')+':'+String(m2).padStart(2,'0')+' → '+min+' min'+power+fuel+rate+spd+pres}).join('\n'):'Pas de détail horaire disponible';return<span title={tooltip} style={{background:'#f0fdf4',border:'1px solid #86efac',borderRadius:5,padding:'1px 7px',color:'#15803d',fontWeight:700,cursor:buckets.length?'help':'default'}}>⚙️ {mr.opH}h fraisage{buckets.length?' ⓘ':''}</span>})()}
{(()=>{const buckets=(mr.opTimeBuckets||[]).filter(b=>b.opH>=0.05&&b.powerPct!=null);if(!buckets.length)return null;const totalOpH=buckets.reduce((s,b)=>s+b.opH,0);if(totalOpH<=0)return null;const wAvg=buckets.reduce((s,b)=>s+b.opH*b.powerPct,0)/totalOpH;const avg=Math.round(wAvg);const color=avg>=60?'#dc2626':avg>=40?'#d97706':'#16a34a';return<span title="Puissance moyenne pondérée pendant les heures de fraisage actif" style={{background:'#f5f3ff',border:'1px solid #8b5cf6',borderRadius:5,padding:'1px 7px',color:color,fontWeight:700,cursor:'help'}}>💪 {avg}% puiss.</span>})()}
{(()=>{const buckets=(mr.opTimeBuckets||[]).filter(b=>b.opH>=0.05&&b.speedKmh!=null);if(!buckets.length)return null;const totalOpH=buckets.reduce((s,b)=>s+b.opH,0);if(totalOpH<=0)return null;const wAvgKmh=buckets.reduce((s,b)=>s+b.opH*b.speedKmh,0)/totalOpH;const mPerMin=wAvgKmh*1000/60;return<span title="Vitesse d'avancement moyenne pondérée pendant les heures de fraisage actif" style={{background:'#ecfeff',border:'1px solid #06b6d4',borderRadius:5,padding:'1px 7px',color:'#155e75',fontWeight:700,cursor:'help'}}>➡️ {mPerMin.toFixed(1)} m/min</span>})()}
{(()=>{const buckets=(mr.opTimeBuckets||[]).filter(b=>b.opH>=0.05&&b.fuelRateLh!=null);if(!buckets.length)return null;const totalOpH=buckets.reduce((s,b)=>s+b.opH,0);if(totalOpH<=0)return null;const wAvg=buckets.reduce((s,b)=>s+b.opH*b.fuelRateLh,0)/totalOpH;return<span title="Consommation moyenne pondérée pendant les heures de fraisage actif" style={{background:'#fef3c7',border:'1px solid #d97706',borderRadius:5,padding:'1px 7px',color:'#92400e',fontWeight:700,cursor:'help'}}>⛽/h {wAvg.toFixed(1)} L/h</span>})()}
{(()=>{const buckets=(mr.opTimeBuckets||[]).filter(b=>b.opH>=0.05&&b.pressureBar!=null);if(!buckets.length)return null;const totalOpH=buckets.reduce((s,b)=>s+b.opH,0);if(totalOpH<=0)return null;const wAvg=buckets.reduce((s,b)=>s+b.opH*b.pressureBar,0)/totalOpH;return<span title="Pression moyenne du système d'entraînement pondérée pendant les heures de fraisage actif" style={{background:'#fce7f3',border:'1px solid #db2777',borderRadius:5,padding:'1px 7px',color:'#831843',fontWeight:700,cursor:'help'}}>🔧 {wAvg.toFixed(0)} bar</span>})()}
{(!mr.rawPts||!mr.rawPts.length)&&<span style={{background:'#fee2e2',border:'1px solid #ef4444',borderRadius:5,padding:'1px 7px',color:'#991b1b',fontWeight:700}}>⚠️ Ancien format — supprimer puis ré-importer</span>}
<button onClick={()=>{if(confirm('Supprimer ce rapport Wirtgen (le chantier sera conservé) ?')){const nd=JSON.parse(JSON.stringify(data));nd.machineReports=(nd.machineReports||[]).filter(r=>r.id!==mr.id);save(nd)}}} title="Supprime uniquement le rapport Wirtgen (le chantier reste)" style={{marginLeft:'auto',background:'#fee2e2',border:'1px solid #ef4444',borderRadius:5,padding:'2px 8px',cursor:'pointer',fontSize:11,color:'#991b1b',fontWeight:700}}>🗑 Suppr rapport</button>
</div>)})()}
<div style={{display:'flex',gap:6,marginTop:6,flexWrap:'wrap'}}>
<button onClick={()=>{setDepotFormEmpId(eId);setShowDepotForm(true)}} style={{background:'#64748b',color:'#fff',border:'none',borderRadius:6,padding:'4px 12px',cursor:'pointer',fontSize:12,fontWeight:600}}>🏠 Affecter au depot</button>
</div>
{j.signature&&j.signature.dataUrl&&<div style={{marginTop:8,background:'#f0fdf4',border:'2px solid #86efac',borderRadius:10,padding:10}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8,flexWrap:'wrap',gap:8}}>
<div>
<div style={{fontWeight:800,color:'#15803d',fontSize:14}}>✍️ Signature chef de chantier</div>
<div style={{fontSize:12,color:'#166534',marginTop:2}}>Par <b>{j.signature.signedBy}</b> le {new Date(j.signature.signedAt).toLocaleString('fr-FR')}</div>
</div>
<button onClick={()=>{if(confirm('Supprimer la signature ?')){const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){delete jj.signature;save(nd)}}}} style={{background:'#fff',border:'1px solid #ef4444',color:'#dc2626',padding:'4px 10px',borderRadius:6,cursor:'pointer',fontSize:11,fontWeight:700}}>🗑 Supprimer</button>
</div>
<img src={j.signature.dataUrl} alt="Signature" style={{maxWidth:'100%',background:'#fff',border:'1px solid '+C.border,borderRadius:8,padding:6,display:'block'}}/>
</div>}
</div>}
</div>)})}
</div>
</div>)})})()}
</React.Fragment>)})})()}
</div>)};
return(
<div>
{/* Barre du haut compacte : [bouton pannes] [< Date >] ... [CA] [📥 JD] */}
<div style={{display:'flex',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
{/* Gauche : bouton pannes (si pannes en cours) */}
{(()=>{const newPannes=(data.panneReports||[]).filter(p=>p.status!=='resolved');if(!newPannes.length)return null;const urgent=newPannes.some(p=>p.severity==='urgent');return<button onClick={()=>setPg('pannes')} title={newPannes.map(p=>{const allEq=[...(data.machines||[]).map(m=>({id:m.id,name:m.name})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name})),...(data.cars||[]).map(c=>({id:c.id,name:c.name}))];const eq=allEq.find(x=>x.id===(p.machineId||p.truckId||p.carId));return(eq?eq.name:'?')+' — '+(p.description||'').slice(0,40)}).join('\n')} style={{background:urgent?'#dc262618':'#d9770618',border:'2px solid '+(urgent?'#dc2626':'#d97706'),color:urgent?C.red:C.orange,borderRadius:8,padding:'6px 14px',cursor:'pointer',fontWeight:700,fontSize:14}}>⚠ {newPannes.length} panne{newPannes.length>1?'s':''}{urgent?' URGENT':''}</button>})()}
{/* Centre : navigation date avec date GROSSE */}
<div style={{display:'flex',alignItems:'center',gap:6,margin:'0 auto'}}>
<button onClick={()=>navDate(-1)} style={btnStyle(C.dim)}>{'<'}</button>
<span style={{fontWeight:800,fontSize:36,color:'#fff',padding:'4px 24px',letterSpacing:'0.5px'}}>{fmtDate(new Date(selDate))}</span>
<button onClick={()=>navDate(1)} style={btnStyle(C.dim)}>{'>'}</button>
<input type="date" value={selDate} onChange={e=>setSelDate(e.target.value)} style={{...inputStyle,width:140,marginLeft:4}}/>
</div>
{/* Droite : CA + bouton import JD */}
<div style={{background:C.card,borderRadius:8,padding:'8px 14px',border:'1px solid '+C.border}}><span style={{fontSize:12,color:C.dim}}>CA jour </span><span style={{fontWeight:700,color:C.accent,fontSize:16}}>{fmtMoney(caTotal)}</span></div>
<button onClick={()=>setShowPlanMap(true)} style={{...btnStyle('#0891b2'),fontSize:13,padding:'6px 12px'}} title="Voir le planning sur la carte (optimiser les trajets)">🗺 Carte planning</button>
<button onClick={()=>{if(document.fullscreenElement){document.exitFullscreen()}else{document.documentElement.requestFullscreen().catch(()=>{})}}} style={{...btnStyle('#7c3aed'),fontSize:13,padding:'6px 12px'}} title="Passer en plein ecran (Echap pour sortir)">⛶ Plein ecran</button>
{typeof setSbHidden==='function'&&<button onClick={()=>setSbHidden(!sbHidden)} style={{...btnStyle('#0f766e'),fontSize:13,padding:'6px 12px'}} title={sbHidden?'Reafficher le menu de gauche':'Masquer le menu de gauche pour gagner de la place'}>{sbHidden?'▶ Menu':'◀ Masquer menu'}</button>}
<button onClick={()=>setShowJdImport(true)} style={{...btnStyle('#16a34a'),fontSize:13,padding:'6px 12px'}} title="Importer rapport John Deere">📥 JD</button>
<input ref={wirtgenRef} type="file" accept=".zip" style={{display:'none'}} onChange={async e=>{const file=e.target.files[0];if(!file)return;try{const report=await parseWirtgenZip(file,selDate);if(!report){alert('Impossible de lire le ZIP Wirtgen — vérifier le format');return;}const mNorm=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');const matchedMach=(data.machines||[]).find(m=>mNorm(m.name)===mNorm(report.machineName));if(matchedMach)report.machineName=matchedMach.name;else if(wirtgenTargetMach)report.machineName=wirtgenTargetMach;const nd=JSON.parse(JSON.stringify(data));if(!nd.machineReports)nd.machineReports=[];nd.machineReports=nd.machineReports.filter(r=>!(mNorm(r.machineName)===mNorm(report.machineName)&&r.date===report.date));nd.machineReports.push(report);save(nd);alert('✅ Rapport Wirtgen importé — '+report.machineName+' / '+report.date);}catch(err){alert('Erreur ZIP: '+err.message);}e.target.value='';}}/>
</div>
<div className="pg" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
{renderCol(['Raboteuse'],'Raboteuses')}
{renderCol(['Balayeuse','Citerne'],'Balayeuses + Citernes')}
</div>
{showForm&&<MissionForm data={data} save={save} job={formJob} onClose={()=>setShowForm(false)} selectedDate={selDate} selectedEmpId={formEmpId}/>}
{mapModal&&<MapModal {...mapModal} onClose={()=>setMapModal(null)}/>}
{geocodeAuto&&geocodeAuto.anchorRect&&(()=>{
  const ar=geocodeAuto.anchorRect;
  // Position du popup juste sous l'input ; si pas assez de place en bas, on remonte
  const top=ar.bottom+4;
  const left=Math.min(ar.left,window.innerWidth-360);
  const getDept=r=>{const a=r.address||{};if(a.postcode){const cp=String(a.postcode);if(cp.length>=2)return cp.slice(0,2)}return null};
  const getDeptName=r=>{const a=r.address||{};return a.county||a.state_district||a.state||''};
  const getCity=r=>{const a=r.address||{};return a.city||a.town||a.village||a.municipality||a.hamlet||''};
  return(<React.Fragment>
    {/* Overlay invisible pour fermer au clic extérieur */}
    <div onClick={()=>setGeocodeAuto(null)} style={{position:'fixed',top:0,left:0,right:0,bottom:0,zIndex:2090,background:'transparent'}}/>
    <div style={{position:'fixed',top,left,width:Math.max(ar.width,340),maxHeight:380,overflowY:'auto',background:'#fff',border:'2px solid '+C.accent,borderRadius:8,boxShadow:'0 6px 24px rgba(0,0,0,0.18)',zIndex:2091,padding:6}}>
      <div style={{fontSize:11,color:C.dim,padding:'4px 8px',fontStyle:'italic',borderBottom:'1px solid '+C.border,marginBottom:4}}>
        {geocodeAuto.loading?'⏳ Recherche…':(geocodeAuto.results.length?'📍 '+geocodeAuto.results.length+' résultat(s) — clique pour valider':'Aucun résultat')}
      </div>
      {(geocodeAuto.results||[]).map((r,i)=>{
        const dept=getDept(r),deptName=getDeptName(r),city=getCity(r);
        const distKm=r._dist?Math.round(r._dist):null;
        return(
        <div key={i} onClick={()=>pickGeocodeResult(geocodeAuto.jobId,r)} style={{padding:'8px 10px',borderRadius:6,marginBottom:3,cursor:'pointer',display:'flex',alignItems:'center',gap:10,background:'#f8fafc'}} onMouseEnter={e=>e.currentTarget.style.background='#e0f2fe'} onMouseLeave={e=>e.currentTarget.style.background='#f8fafc'}>
          {dept&&<div style={{background:C.accent,color:'#fff',fontWeight:800,fontSize:14,padding:'4px 7px',borderRadius:6,minWidth:32,textAlign:'center',flexShrink:0}}>{dept}</div>}
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{city||r.display_name.split(',')[0]}{deptName?' — '+deptName:''}</div>
            <div style={{fontSize:10,color:C.dim,marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{r.display_name}</div>
          </div>
          {distKm!=null&&<div style={{fontSize:10,color:C.dim,flexShrink:0,fontWeight:600}}>{distKm<1?'<1':distKm}km</div>}
        </div>
        );
      })}
    </div>
  </React.Fragment>);
})()}
{showPlanMap&&(()=>{
  // Construction des marqueurs pour une date donnée + dayOffset (-1=veille, 0=selDate, +1=lendemain)
  const buildMarkersFor=(dateISO,dayOffset)=>{
    const jobs=(data.jobs||[]).filter(j=>j.date===dateISO&&j.type!=='depot');
    // Numérotation par chauffeur : si un chauffeur a plusieurs chantiers le jour, 1, 2, 3 dans l'ordre billingStart
    const seqMap={};
    const byDriver={};
    jobs.forEach(jb=>{if(jb.employeeId){(byDriver[jb.employeeId]=byDriver[jb.employeeId]||[]).push(jb)}});
    Object.values(byDriver).forEach(arr=>{
      arr.sort((a,b)=>(a.billingStart||'99:99').localeCompare(b.billingStart||'99:99'));
      if(arr.length>1)arr.forEach((jb,i)=>{seqMap[jb.id]=i+1});
    });
    return jobs.map(jb=>{
      const mc=getMach(jb.machineId);
      const emp=(data.employees||[]).find(e=>e.id===jb.employeeId);
      const cl=getClient(jb.clientId);
      const co=parseCoords(jb.gps||jb._geocodedGps);
      if(!co)return null;
      const mcName=mc&&mc.name?mc.name:'?';
      const mcType=mc&&mc.type?mc.type:'';
      const empName=emp&&emp.name?emp.name:'';
      let mainLabel,secondLine='';
      if(mcType==='Balayeuse'){
        // Balayeuse : prénom chauffeur (machine déjà inutile)
        mainLabel=empName?empName.split(' ')[0]:(mcName||'?');
      }else{
        // Raboteuse / Citerne / autre : nom machine + prénom chauffeur dessous
        mainLabel=mcName;
        if(empName)secondLine=empName.split(' ')[0];
      }
      return {co:[co[0],co[1]],color:widthColor(mc),mainLabel,secondLine,seq:seqMap[jb.id]||null,billingStart:jb.billingStart||'',machineName:mcName,driverName:empName,clientName:cl&&cl.name?cl.name:'',location:jb.location||'',forfaitType:jb.forfaitType||'',mcType,dayOffset,dateISO,isNight:!!jb.isNight};
    }).filter(x=>x);
  };
  // Date helpers
  const offsetISO=(iso,days)=>{const d=new Date(iso);d.setDate(d.getDate()+days);return fmtDateISO(d)};
  const veilleISO=offsetISO(selDate,-1);
  const surlendISO=offsetISO(selDate,1);
  // Assemble markers
  let markers=buildMarkersFor(selDate,0);
  if(planMapShowVeille)markers=[...markers,...buildMarkersFor(veilleISO,-1)];
  if(planMapShowSurlend)markers=[...markers,...buildMarkersFor(surlendISO,1)];
  // Décalage des marqueurs qui se superposent
  const groups={};
  markers.forEach(mk=>{const k=mk.co[0].toFixed(4)+','+mk.co[1].toFixed(4);(groups[k]=groups[k]||[]).push(mk)});
  Object.values(groups).forEach(g=>{
    if(g.length<=1)return;
    const offsetDeg=0.0008;
    g.forEach((mk,i)=>{const ang=(2*Math.PI*i)/g.length;mk.co=[mk.co[0]+offsetDeg*Math.cos(ang),mk.co[1]+offsetDeg*Math.sin(ang)]});
  });
  // Dépôts
  const depotsOnMap=(data.depots||[]).map(d=>({name:d.name||'Dépôt',co:d._coords?parseCoords(typeof d._coords==='string'?d._coords:d._coords.join(',')):null})).filter(d=>d.co);
  return<MapModalPlanning selDate={selDate} veilleISO={veilleISO} surlendISO={surlendISO} markers={markers} depots={depotsOnMap} showVeille={planMapShowVeille} showSurlend={planMapShowSurlend} onToggleVeille={()=>setPlanMapShowVeille(v=>!v)} onToggleSurlend={()=>setPlanMapShowSurlend(v=>!v)} onClose={()=>setShowPlanMap(false)}/>;
})()}
{showDepotForm&&<Mod title="Journee depot" onClose={()=>setShowDepotForm(false)} width={400}>
<Fl label="Depot"><select style={inputStyle} value={depotFormDepotId} onChange={e=>setDepotFormDepotId(e.target.value)}><option value="">-- Choisir --</option>{(data.depots||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Fl>
<Fl label="Activite"><select style={inputStyle} value={depotFormActivity} onChange={e=>setDepotFormActivity(e.target.value)}>{DEPOT_ACTIVITIES.map(a=><option key={a} value={a}>{a}</option>)}</select></Fl>
{depotFormActivity==='Autre'&&<Fl label="Description"><input style={inputStyle} value={depotFormDesc} onChange={e=>setDepotFormDesc(e.target.value)} placeholder="Description libre"/></Fl>}
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={saveDepotJob} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>setShowDepotForm(false)} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
{dupJobId&&(()=>{const srcJob=(data.jobs||[]).find(j=>j.id===dupJobId);if(!srcJob)return null;const empO=(data.employees||[]).find(e=>e.id===srcJob.employeeId);const empN=empO?empO.name:'?';const clO=getClient(srcJob.clientId);const clN=clO?clO.name:'?';const doDup=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.jobs)nd.jobs=[];const baseDate=new Date(srcJob.date);for(let i=1;i<=dupDays;i++){const d=new Date(baseDate);d.setDate(d.getDate()+i);const ds=fmtDateISO(d);const exists=nd.jobs.some(j2=>j2.employeeId===srcJob.employeeId&&j2.machineId===srcJob.machineId&&j2.clientId===srcJob.clientId&&j2.date===ds);if(!exists){const nj={...JSON.parse(JSON.stringify(srcJob)),id:uid(),date:ds,sent:false,ack:false};nd.jobs.push(nj)}}save(nd);setDupJobId(null)};return(
<Mod title="Dupliquer le chantier" onClose={()=>setDupJobId(null)} width={400}>
<div style={{fontSize:14,marginBottom:12}}>
<div><b>{empN}</b> · {(getMach(srcJob.machineId)||{}).name||'?'}</div>
<div style={{color:C.dim}}>{clN} · {srcJob.location||'sans lieu'}</div>
<div style={{color:C.dim}}>Date source : {fmtDate(new Date(srcJob.date))}</div>
</div>
<Fl label="Nombre de jours a dupliquer">
<div style={{display:'flex',gap:8,alignItems:'center'}}>
<input type="number" min="1" max="30" style={{...inputStyle,width:80,fontSize:16,textAlign:'center'}} value={dupDays} onChange={e=>setDupDays(Math.max(1,Math.min(30,Number(e.target.value)||1)))}/>
<span style={{fontSize:14,color:C.dim}}>jour{dupDays>1?'s':''} suivant{dupDays>1?'s':''}</span>
</div>
</Fl>
<div style={{fontSize:13,color:C.dim,marginBottom:12}}>Le chantier sera copie du <b>{(()=>{const d=new Date(srcJob.date);d.setDate(d.getDate()+1);return fmtDate(d)})()}</b> au <b>{(()=>{const d=new Date(srcJob.date);d.setDate(d.getDate()+dupDays);return fmtDate(d)})()}</b> (meme chauffeur, machine, client, lieu, forfait)</div>
<div style={{display:'flex',gap:8}}><button onClick={doDup} style={btnStyle(C.accent,true)}>Dupliquer {dupDays} jour{dupDays>1?'s':''}</button><button onClick={()=>setDupJobId(null)} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>)})()}
{showJdImport&&<Mod title="Import John Deere — Analyseur de machine" onClose={()=>{setShowJdImport(false);setJdImportRows([]);setJdImportStatus('');}} width={580}><div style={{fontSize:13,color:C.dim,marginBottom:12}}>Selectionnez le fichier .xlsx exporté depuis JD Operations Center (Analyseur de machine).</div><Fl label="Fichier Excel (.xlsx)"><input type="file" accept=".xlsx,.xls" style={inputStyle} onChange={e=>handleJdFile(e.target.files[0])}/></Fl>{jdImportStatus&&<div style={{fontSize:13,padding:'6px 10px',borderRadius:6,marginBottom:8,background:jdImportStatus.startsWith('✅')?'#dcfce7':'#fefce8',color:jdImportStatus.startsWith('✅')?C.green:jdImportStatus.startsWith('Erreur')?C.red:C.orange}}>{jdImportStatus}</div>}{jdImportRows.length>0&&<div style={{marginBottom:12}}><div style={{fontSize:12,fontWeight:700,color:C.dim,marginBottom:6}}>Aperçu — {jdImportRows.length} machine(s) :</div><div style={{border:'1px solid '+C.border,borderRadius:6,overflow:'auto',maxHeight:240}}><table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}><thead><tr style={{background:'#f8fafc'}}><th style={{padding:'4px 8px',textAlign:'left',borderBottom:'1px solid '+C.border}}>Machine</th><th style={{padding:'4px 8px',textAlign:'left',borderBottom:'1px solid '+C.border}}>Date</th><th style={{padding:'4px 8px',textAlign:'right',borderBottom:'1px solid '+C.border}}>Travail h</th><th style={{padding:'4px 8px',textAlign:'right',borderBottom:'1px solid '+C.border}}>Ralenti h</th><th style={{padding:'4px 8px',textAlign:'right',borderBottom:'1px solid '+C.border}}>Carbu L</th><th style={{padding:'4px 8px',textAlign:'center',borderBottom:'1px solid '+C.border}}>OK</th></tr></thead><tbody>{jdImportRows.map((r,i)=><tr key={i} style={{background:r.matched?'#f0fdf4':'#fef2f2'}}><td style={{padding:'3px 8px',fontWeight:600,color:r.matched?C.green:C.red}}>{r.rawName}</td><td style={{padding:'3px 8px'}}>{r.reportDate}</td><td style={{padding:'3px 8px',textAlign:'right'}}>{r.workingH!=null?r.workingH:'-'}</td><td style={{padding:'3px 8px',textAlign:'right'}}>{r.idleH!=null?r.idleH:'-'}</td><td style={{padding:'3px 8px',textAlign:'right'}}>{r.totalFuel!=null?r.totalFuel:'-'}</td><td style={{padding:'3px 8px',textAlign:'center'}}>{r.matched?'✅':'❌'}</td></tr>)}</tbody></table></div><div style={{fontSize:11,color:C.dim,marginTop:4}}>✅ machine reconnue · ❌ non trouvée dans JD</div></div>}<div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}><button onClick={()=>{setShowJdImport(false);setJdImportRows([]);setJdImportStatus('');}} style={btnStyle(C.dim)}>Annuler</button>{jdImportRows.filter(r=>r.matched).length>0&&<button onClick={doJdImport} disabled={jdImporting} style={btnStyle(C.green,true)}>Importer {jdImportRows.filter(r=>r.matched).length} machine{jdImportRows.filter(r=>r.matched).length>1?'s':''}</button>}</div></Mod>}
</div>)};

// ======== DASHBOARD ========
const DashboardPage=({data})=>{
const[period,setPeriod]=useState('Semaine');const[offset,setOffset]=useState(0);
const wdpm=data.workDaysPerMonth||22;
const yearStart=data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1));
const range=useMemo(()=>{const now=new Date();if(period==='Jour'){const d=new Date(now);d.setDate(d.getDate()+offset);const s=fmtDateISO(d);return{start:s,end:s,label:fmtDate(d)}}if(period==='Semaine'){const d=new Date(now);d.setDate(d.getDate()+offset*7);const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);const mon=new Date(d);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);return{start:fmtDateISO(mon),end:fmtDateISO(sun),label:fmtDate(mon)+' - '+fmtDate(sun)}}if(period==='Annee'){const yr=now.getFullYear()+offset;return{start:yr+'-01-01',end:yr+'-12-31',label:''+yr}}const d=new Date(now.getFullYear(),now.getMonth()+offset,1);const last=new Date(d.getFullYear(),d.getMonth()+1,0);return{start:fmtDateISO(d),end:fmtDateISO(last),label:d.toLocaleString('fr-FR',{month:'long',year:'numeric'})}},[period,offset]);
const prevRange=useMemo(()=>{const now=new Date();const o2=offset-1;if(period==='Jour'){const d=new Date(now);d.setDate(d.getDate()+o2);const s=fmtDateISO(d);return{start:s,end:s}}if(period==='Semaine'){const d=new Date(now);d.setDate(d.getDate()+o2*7);const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);const mon=new Date(d);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);return{start:fmtDateISO(mon),end:fmtDateISO(sun)}}if(period==='Annee'){const yr=now.getFullYear()+o2;return{start:yr+'-01-01',end:yr+'-12-31'}}const d=new Date(now.getFullYear(),now.getMonth()+o2,1);const last=new Date(d.getFullYear(),d.getMonth()+1,0);return{start:fmtDateISO(d),end:fmtDateISO(last)}},[period,offset]);
const jobs=useMemo(()=>(data.jobs||[]).filter(j=>j.date>=range.start&&j.date<=range.end&&j.type!=='depot'),[data.jobs,range]);
const prevJobs=useMemo(()=>(data.jobs||[]).filter(j=>j.date>=prevRange.start&&j.date<=prevRange.end&&j.type!=='depot'),[data.jobs,prevRange]);
const caTotal=jobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const prevCA=prevJobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const calcCosts=(jobList)=>{let total=0;jobList.forEach(j=>{const emp=(data.employees||[]).find(e=>e.id===j.employeeId);const m=(data.machines||[]).find(x=>x.id===j.machineId);const hourly=emp?Number(emp.hourlySalary)||0:0;const chargesRate=emp?Number(emp.chargesRate)||45:45;const mealA=emp?Number(emp.mealAllowance)||12:12;const fh=forfaitHours(j.forfaitType);const salBrut=fh*hourly;const salCharges=salBrut*(1+chargesRate/100);const fuelType=getMachineFuelType(data,j.machineId);const truck2=(data.trucks||[]).find(t=>emp&&t.id===emp.truckId);const truckC=truck2?Number(truck2.fuelPer100)||25:25;const trajKm=(j.distanceKm||0);const trajL=(trajKm/100)*truckC;const fuelPr=getFuelPrice(data,fuelType,j.startFrom!=='home'?j.startFrom:null);const trajCost=trajL*fuelPr;const machFuelPr=getFuelPrice(data,fuelType,j.machineFuelDepot);const machCost=(j.machineFuelL||0)*machFuelPr;const assM=m?((m.insuranceMonthly||0)/wdpm):0;const credM=m?(Number(m.creditMonthly)||0)/wdpm:0;const ctM=m?((m.ctCost||0)/12)/wdpm:0;const assT=truck2?((truck2.insuranceMonthly||0)/wdpm):0;const credT=truck2?(Number(truck2.creditMonthly)||0)/wdpm:0;const ctT=truck2?((truck2.ctCost||0)/12)/wdpm:0;total+=salCharges+mealA+trajCost+machCost+assM+credM+ctM+assT+credT+ctT});return total};
const costsTotal=calcCosts(jobs);const prevCosts=calcCosts(prevJobs);
const totalEntretienPeriod=(data.interventions||[]).filter(i=>i.date>=range.start&&i.date<=range.end).reduce((s,i)=>s+(i.totalCost||0),0);
const totalEntretienYTD=(data.interventions||[]).filter(i=>i.date>=yearStart).reduce((s,i)=>s+(i.totalCost||0),0);
const benefBrutTotal=caTotal-costsTotal;
const benefCumYTD=useMemo(()=>{const allJ=(data.jobs||[]).filter(j=>j.date>=yearStart&&j.date<=range.end&&j.type!=='depot');return allJ.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0)-calcCosts(allJ)},[data,yearStart,range]);
const resteEntretien=totalEntretienYTD-benefCumYTD;
const benefAffiche=resteEntretien>0?0:benefBrutTotal;
const prevBenef=prevCA-prevCosts;
const margePct=caTotal>0?((benefAffiche/caTotal)*100):0;
const caByType={};jobs.forEach(j=>{const m=(data.machines||[]).find(x=>x.id===j.machineId);const t=m?m.type:'Autre';caByType[t]=(caByType[t]||0)+(j.priceForfait||0)});
const maxCABar=Math.max(...Object.values(caByType),1);
const clientCA={};jobs.forEach(j=>{const cn=(data.clients||[]).find(c=>c.id===j.clientId);const n=cn?cn.name:'?';if(!clientCA[n])clientCA[n]={ca:0,cnt:0};clientCA[n].ca+=(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0);clientCA[n].cnt++});
const topCl=Object.entries(clientCA).sort((a,b)=>b[1].ca-a[1].ca);
const alerts=useMemo(()=>{const a=[];const d30=fmtDateISO(new Date(Date.now()+30*86400000));(data.panneReports||[]).filter(p=>p.status==='new'&&p.severity==='urgent').forEach(p=>{const eq=[...(data.machines||[]),...(data.trucks||[]),...(data.cars||[])].find(x=>x.id===(p.machineId||p.truckId||p.carId));a.push({t:'Panne urgente: '+(eq?eq.name:'?')+' - '+(p.description||'').substring(0,40),c:C.red,type:'panne'})});(data.parts||[]).filter(p=>(p.quantity||0)<=(p.minStock||2)).forEach(p=>{a.push({t:'Stock bas: '+p.name+' ('+p.quantity+')',c:C.orange,type:'stock'})});(data.trucks||[]).concat(data.cars||[]).forEach(v=>{if(v.ctDate&&v.ctDate<=d30)a.push({t:'CT '+v.name+' : '+v.ctDate,c:C.orange,type:'ct'});if(v.vidangeDate&&v.vidangeDate<=d30)a.push({t:'Vidange '+v.name+' : '+v.vidangeDate,c:C.orange,type:'vidange'})});(data.panneReports||[]).filter(p=>p.status!=='resolved'&&p.severity!=='urgent').forEach(p=>{a.push({t:'Panne: '+(p.description||'').substring(0,40),c:C.orange,type:'panne'})});return a},[data]);
const machStats=useMemo(()=>(data.machines||[]).map(mach=>{const mJobs=jobs.filter(j=>j.machineId===mach.id);const ca=mJobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);const fuelCost=mJobs.reduce((s,j)=>{const ft=getMachineFuelType(data,mach.id);const fp=getFuelPrice(data,ft,j.machineFuelDepot);return s+(j.machineFuelL||0)*fp},0);const assJour=(mach.insuranceMonthly||0)/wdpm;const credJour=(Number(mach.creditMonthly)||0)/wdpm;const ctJour=((mach.ctCost||0)/12)/wdpm;const daysUsed=[...new Set(mJobs.map(j=>j.date))].length;const fixedCost=(assJour+credJour+ctJour)*daysUsed;const interCost=(data.interventions||[]).filter(i=>i.machineId===mach.id&&i.date>=range.start&&i.date<=range.end).reduce((s,i)=>s+(i.totalCost||0),0);const cost=fuelCost+fixedCost+interCost;const benef=ca-cost;const margePct2=ca>0?((benef/ca)*100):0;const months2=[];const d=new Date(yearStart);for(let i2=0;i2<12;i2++){const mo=new Date(d.getFullYear(),d.getMonth()+i2,1);const last=new Date(mo.getFullYear(),mo.getMonth()+1,0);if(mo>new Date())break;const ms=fmtDateISO(mo);const me=fmtDateISO(last);const moJobs=(data.jobs||[]).filter(j2=>j2.machineId===mach.id&&j2.date>=ms&&j2.date<=me&&j2.type!=='depot');const moCa=moJobs.reduce((s2,j2)=>s2+(j2.priceForfait||0)+(j2.hasTransfer?j2.transferPrice||0:0),0);const moInter=(data.interventions||[]).filter(ii=>ii.machineId===mach.id&&ii.date>=ms&&ii.date<=me).reduce((s2,ii)=>s2+(ii.totalCost||0),0);const moFuel=moJobs.reduce((s2,j2)=>{const ft2=getMachineFuelType(data,mach.id);const fp2=getFuelPrice(data,ft2,j2.machineFuelDepot);return s2+(j2.machineFuelL||0)*fp2},0);months2.push({label:mo.toLocaleString('fr-FR',{month:'short'}),ca:moCa,cost:moFuel+moInter+(assJour+credJour+ctJour)*([...new Set(moJobs.map(j2=>j2.date))].length)})}let cumBenef=0;let pmLabel=null;months2.forEach(mo2=>{cumBenef+=mo2.ca-mo2.cost;if(cumBenef>0&&!pmLabel)pmLabel=mo2.label});return{name:mach.name,type:mach.type,ca,cost,benef,margePct:margePct2,pmLabel}}),[data,jobs,range,yearStart,wdpm]);
const driverStats=useMemo(()=>{const empIds=[...new Set(jobs.map(j=>j.employeeId))];return empIds.map(eId=>{const emp=(data.employees||[]).find(e=>e.id===eId);if(!emp)return null;const eJobs=jobs.filter(j=>j.employeeId===eId);const ca=eJobs.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);const hourly=Number(emp.hourlySalary)||0;const chargesRate=Number(emp.chargesRate)||45;const salBrut=hourly;const workDays=[...new Set(eJobs.map(j=>j.date))].length;const te=(data.timeEntries||[]).filter(t=>t.empId===eId&&t.date>=range.start&&t.date<=range.end);let totalWorkMin=0;te.forEach(t=>{totalWorkMin+=calcWorkedMin(t)});const salTotal=(totalWorkMin/60)*hourly;const salCharges=salTotal*(1+chargesRate/100);const ratio=salCharges>0?(ca/salCharges):0;return{name:emp.name,ca,salCharges,missions:eJobs.length,days:workDays,ratio,initial:(emp.name||'?')[0].toUpperCase()}}).filter(Boolean).sort((a,b)=>b.ca-a.ca)},[data,jobs,range]);
const totalStockVal=(data.parts||[]).reduce((s,p)=>s+(p.quantity||0)*(p.unitPrice||0),0);
const lowStockParts=(data.parts||[]).filter(p=>(p.quantity||0)<=(p.minStock||2));
const unresolvedPannes=(data.panneReports||[]).filter(p=>p.status!=='resolved');
const inProgressPannes=(data.panneReports||[]).filter(p=>p.status==='in_progress');
const monthInterventions=(data.interventions||[]).filter(i=>i.date>=range.start&&i.date<=range.end);
const monthInterCost=monthInterventions.reduce((s,i)=>s+(i.totalCost||0),0);
const pctDiff=(cur,prev)=>{if(!prev)return null;const d=((cur-prev)/Math.abs(prev))*100;return d};
const kpi=(l,v,c,prev)=>{const diff=pctDiff(typeof v==='number'?v:0,prev);return(<div style={{background:C.card,borderRadius:10,padding:16,border:'1px solid '+C.border}}><div style={{fontSize:12,color:C.dim,marginBottom:4}}>{l}</div><div style={{fontSize:22,fontWeight:800,color:c||C.text}}>{typeof v==='number'?fmtMoney(v):v}</div>{diff!==null&&<div style={{fontSize:11,marginTop:4,color:diff>=0?C.green:C.red,fontWeight:600}}>{diff>=0?'▲':'▼'} {Math.abs(diff).toFixed(0)}% vs prec.</div>}</div>)};
const calendarDays=useMemo(()=>{if(period!=='Mois')return[];const d=new Date(range.start);const yr=d.getFullYear();const mo=d.getMonth();const first=new Date(yr,mo,1);const last=new Date(yr,mo+1,0);const startDay=(first.getDay()+6)%7;const days=[];for(let i=0;i<startDay;i++)days.push(null);for(let i=1;i<=last.getDate();i++){const ds=yr+'-'+pad2(mo+1)+'-'+pad2(i);const dj=(data.jobs||[]).filter(j=>j.date===ds&&j.type!=='depot');const dca=dj.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);days.push({day:i,date:ds,missions:dj.length,ca:dca})}return days},[period,range,data.jobs]);
const maxDayCA=Math.max(...calendarDays.filter(Boolean).map(d=>d.ca),1);
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:8}}>
<h2 style={{margin:0,fontSize:20}}>Dashboard</h2>
<div style={{display:'flex',alignItems:'center',gap:6}}>
{['Jour','Semaine','Mois','Annee'].map(p=><button key={p} onClick={()=>{setPeriod(p);setOffset(0)}} style={{...btnStyle(C.accent,period===p),fontSize:13}}>{p}</button>)}
<button onClick={()=>setOffset(o=>o-1)} style={btnStyle(C.dim)}>{'<'}</button><span style={{fontWeight:600,fontSize:14}}>{range.label}</span><button onClick={()=>setOffset(o=>o+1)} style={btnStyle(C.dim)}>{'>'}</button>
</div></div>
<div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
{kpi('CA',caTotal,C.accent,prevCA)}
{kpi('Couts',costsTotal+totalEntretienPeriod,C.red,prevCosts)}
{kpi('Benefice',benefAffiche,benefAffiche>=0?C.green:C.red,prevBenef)}
<div style={{background:C.card,borderRadius:10,padding:16,border:'1px solid '+C.border}}><div style={{fontSize:12,color:C.dim,marginBottom:4}}>Missions</div><div style={{fontSize:22,fontWeight:800}}>{jobs.length}</div><div style={{fontSize:11,marginTop:4,color:C.dim}}>Marge: <b style={{color:margePct>=0?C.green:C.red}}>{margePct.toFixed(0)}%</b></div></div>
</div>
{alerts.length>0&&<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:8,color:C.red}}>Alertes ({alerts.length})</div>
{alerts.map((a,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:8,fontSize:13,padding:'6px 8px',marginBottom:4,borderRadius:6,borderLeft:'3px solid '+a.c,background:a.c+'08'}}><Bg text={a.type} color={a.c}/><span>{a.t}</span></div>)}
</div>}
<div className="pg" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>CA par type</div>
<div style={{display:'flex',alignItems:'flex-end',gap:16,height:120}}>
{[['Raboteuse','#008965'],['Balayeuse',C.green],['Citerne',C.cyan]].map(([t,color])=>(
<div key={t} style={{flex:1,textAlign:'center'}}><div style={{height:Math.max(((caByType[t]||0)/maxCABar)*100,4),background:color,borderRadius:4,marginBottom:4}}/><div style={{fontSize:11,fontWeight:600}}>{t}</div><div style={{fontSize:11,color:C.dim}}>{fmtMoney(caByType[t]||0)}</div></div>
))}
</div></div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Top clients</div>
{topCl.slice(0,8).map(([n,d],i)=><div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:13,padding:'4px 0',borderBottom:'1px solid #f1f5f9'}}><span style={{fontWeight:i<3?700:400}}>{i+1}. {n}</span><span><b>{fmtMoney(d.ca)}</b> <span style={{color:C.dim}}>({d.cnt})</span></span></div>)}
</div></div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Rentabilite par machine</div>
<div style={{overflowX:'auto'}}>
<table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
<thead><tr style={{borderBottom:'2px solid '+C.border}}>{['Machine','CA','Couts','Benef','Marge%','Point mort'].map(h=><th key={h} style={{textAlign:'left',padding:'6px 8px',color:C.dim,fontWeight:600,fontSize:12}}>{h}</th>)}</tr></thead>
<tbody>{machStats.map((ms,i)=><tr key={i} style={{borderBottom:'1px solid '+C.border}}>
<td style={{padding:'6px 8px',fontWeight:700,color:MC[ms.type]||C.accent}}>{ms.name}</td>
<td style={{padding:'6px 8px',color:C.accent,fontWeight:600}}>{fmtMoney(ms.ca)}</td>
<td style={{padding:'6px 8px',color:C.red}}>{fmtMoney(ms.cost)}</td>
<td style={{padding:'6px 8px',fontWeight:700,color:ms.benef>=0?C.green:C.red}}>{ms.benef>=0?'+':''}{fmtMoney(ms.benef)}</td>
<td style={{padding:'6px 8px'}}><span style={{fontWeight:700,color:ms.margePct>=30?C.green:ms.margePct>=0?C.orange:C.red}}>{ms.margePct.toFixed(0)}%</span></td>
<td style={{padding:'6px 8px'}}>{ms.pmLabel?<Bg text={ms.pmLabel} color={C.green}/>:<Bg text="pas atteint" color={C.orange}/>}</td>
</tr>)}</tbody>
</table></div></div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Rentabilite par chauffeur</div>
<div style={{overflowX:'auto'}}>
<table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
<thead><tr style={{borderBottom:'2px solid '+C.border}}>{['Chauffeur','CA genere','Sal+charges','Missions','Jours','Ratio'].map(h=><th key={h} style={{textAlign:'left',padding:'6px 8px',color:C.dim,fontWeight:600,fontSize:12}}>{h}</th>)}</tr></thead>
<tbody>{driverStats.map((ds,i)=><tr key={i} style={{borderBottom:'1px solid '+C.border}}>
<td style={{padding:'6px 8px'}}><div style={{display:'flex',alignItems:'center',gap:6}}><div style={{width:24,height:24,borderRadius:'50%',background:C.accent,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700}}>{ds.initial}</div><span style={{fontWeight:600}}>{ds.name}</span></div></td>
<td style={{padding:'6px 8px',color:C.accent,fontWeight:600}}>{fmtMoney(ds.ca)}</td>
<td style={{padding:'6px 8px',color:C.red}}>{fmtMoney(ds.salCharges)}</td>
<td style={{padding:'6px 8px'}}>{ds.missions}</td>
<td style={{padding:'6px 8px'}}>{ds.days}</td>
<td style={{padding:'6px 8px'}}><span style={{fontWeight:700,color:ds.ratio>=7?C.green:ds.ratio>=5?C.orange:C.red}}>{ds.ratio.toFixed(1)}x</span></td>
</tr>)}</tbody>
</table></div></div>
<div className="pg" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Stock pieces</div>
<div style={{fontSize:13,marginBottom:6}}>Total: <b>{(data.parts||[]).reduce((s,p)=>s+(p.quantity||0),0)}</b> pieces | Valeur: <b style={{color:C.accent}}>{fmtMoney(totalStockVal)}</b></div>
{lowStockParts.length>0&&<div style={{marginTop:6}}>{lowStockParts.map((p,i)=><div key={i} style={{fontSize:12,color:C.orange,padding:'2px 0'}}>&#9888; {p.name}: {p.quantity} restant(s)</div>)}</div>}
{lowStockParts.length===0&&<div style={{fontSize:12,color:C.green}}>Tous les stocks OK</div>}
</div>
<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Pannes & Interventions</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,fontSize:13}}>
<div>Non resolues: <b style={{color:unresolvedPannes.length>0?C.red:C.green}}>{unresolvedPannes.length}</b></div>
<div>En cours: <b style={{color:C.orange}}>{inProgressPannes.length}</b></div>
<div>Interventions: <b>{monthInterventions.length}</b></div>
<div>Cout: <b style={{color:C.red}}>{fmtMoney(monthInterCost)}</b></div>
</div></div></div>
{period==='Mois'&&calendarDays.length>0&&<div style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border}}>
<div style={{fontWeight:700,fontSize:14,marginBottom:10}}>Calendrier</div>
<div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2}}>
{['L','M','M','J','V','S','D'].map((d,i)=><div key={i} style={{textAlign:'center',fontSize:11,fontWeight:700,color:C.dim,padding:4}}>{d}</div>)}
{calendarDays.map((d,i)=>d?<div key={i} style={{textAlign:'center',padding:6,borderRadius:6,background:d.ca>0?'rgba(0,137,101,'+(0.1+0.6*(d.ca/maxDayCA)).toFixed(2)+')':'#f8fafc',border:'1px solid '+C.border,cursor:'default'}}>
<div style={{fontSize:12,fontWeight:d.missions>0?700:400,color:d.missions>0?C.text:C.muted}}>{d.day}</div>
{d.missions>0&&<div style={{fontSize:9,fontWeight:700,color:C.accent}}>{d.missions}m</div>}
</div>:<div key={i}/>)}
</div></div>}
</div>)};

// ======== DEPOTS ========
const DepotsPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const[outType,setOutType]=useState(null);const[outDepot,setOutDepot]=useState(null);
const[outL,setOutL]=useState('');const[outEmp,setOutEmp]=useState('');const[outMach,setOutMach]=useState('');const[outTruck,setOutTruck]=useState('');const[outDate,setOutDate]=useState(fmtDateISO(new Date()));
const blank={name:'',address:'',_coords:null,gnrStock:0,gnrPrice:0,gazoleStock:0,gazolePrice:0,gnrHistory:[],gazoleHistory:[]};
const open=d=>{setSel(d?{...d}:{...blank,id:uid()});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const ds=data.depots||[];const idx=ds.findIndex(d=>d.id===sel.id);const nd=idx>=0?ds.map(d=>d.id===sel.id?sel:d):[...ds,sel];save({...data,depots:nd});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,depots:(data.depots||[]).filter(d=>d.id!==sel.id)});close()};
const doOut=()=>{if(!outDepot||!outL)return;const nd=JSON.parse(JSON.stringify(data));const dep=nd.depots.find(d=>d.id===outDepot);if(!dep)return;const liters=Number(outL)||0;const fld=outType==='gnr'?'gnr':'gazole';dep[fld+'Stock']=Math.max(0,(dep[fld+'Stock']||0)-liters);const hist=dep[fld+'History']||[];hist.unshift({type:'out',liters,date:outDate,employeeName:(nd.employees||[]).find(e=>e.id===outEmp)?.name||'',machineName:(nd.machines||[]).find(m=>m.id===outMach)?.name||'',truckName:(nd.trucks||[]).find(t=>t.id===outTruck)?.name||''});dep[fld+'History']=hist.slice(0,30);save(nd);setOutType(null);setOutDepot(null);setOutL('');setOutEmp('');setOutMach('');setOutTruck('')};
const gauge=(stock,price,color,label)=>{const maxL=5000;const pct=Math.min((stock/maxL)*100,100);return(
<div style={{flex:1}}><div style={{fontSize:12,fontWeight:700,color,marginBottom:4}}>{label}</div>
<div style={{height:16,background:'#e2e8f0',borderRadius:8,overflow:'hidden'}}><div style={{height:'100%',background:color,width:pct+'%',borderRadius:8,transition:'width .3s'}}/></div>
<div style={{fontSize:11,color:C.dim,marginTop:2}}>{stock||0} L | {fmtMoney(price)}/L | Total: {fmtMoney((stock||0)*(price||0))}</div>
{stock<200&&<div style={{fontSize:11,color:C.red,fontWeight:600}}>Stock bas!</div>}
</div>)};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Depots</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
{(data.depots||[]).map(dep=>(
<div key={dep.id} style={{background:C.card,borderRadius:12,padding:16,marginBottom:12,border:'1px solid '+C.border}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
<div><strong style={{fontSize:16}}>{dep.name}</strong><div style={{fontSize:12,color:C.dim}}>{dep.address||'Pas d\'adresse'} {dep._coords?'(GPS ok)':''}</div></div>
<EBtn onClick={()=>open(dep)}/></div>
<div style={{display:'flex',gap:16,marginBottom:10}}>{gauge(dep.gnrStock,dep.gnrPrice,C.orange,'GNR')}{gauge(dep.gazoleStock,dep.gazolePrice,C.accent,'Gazole')}</div>
<div style={{display:'flex',gap:6,marginBottom:8}}>
<button onClick={()=>{setOutType('gnr');setOutDepot(dep.id)}} style={{...btnStyle(C.orange),padding:'4px 10px',fontSize:12}}>Sortie GNR</button>
<button onClick={()=>{setOutType('gazole');setOutDepot(dep.id)}} style={{...btnStyle(C.accent),padding:'4px 10px',fontSize:12}}>Sortie Gazole</button>
</div>
{outType&&outDepot===dep.id&&<div style={{background:C.bg,borderRadius:8,padding:10,marginBottom:8,border:'1px solid '+C.border}}>
<div style={{fontWeight:600,fontSize:13,marginBottom:6}}>Sortie {outType==='gnr'?'GNR':'Gazole'}</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Chauffeur"><select style={inputStyle} value={outEmp} onChange={e=>setOutEmp(e.target.value)}><option value="">--</option>{(data.employees||[]).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></Fl>
<Fl label="Machine"><select style={inputStyle} value={outMach} onChange={e=>setOutMach(e.target.value)}><option value="">--</option>{(data.machines||[]).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Fl>
{outType==='gazole'&&<Fl label="Camion"><select style={inputStyle} value={outTruck} onChange={e=>setOutTruck(e.target.value)}><option value="">--</option>{(data.trucks||[]).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Fl>}
<Fl label="Litres"><input type="number" style={inputStyle} value={outL} onChange={e=>setOutL(e.target.value)}/></Fl>
<Fl label="Date"><input type="date" style={inputStyle} value={outDate} onChange={e=>setOutDate(e.target.value)}/></Fl>
</div>
<div style={{display:'flex',gap:6}}><button onClick={doOut} style={btnStyle(C.accent,true)}>Valider</button><button onClick={()=>{setOutType(null);setOutDepot(null)}} style={btnStyle(C.dim)}>Annuler</button></div>
</div>}
<div style={{fontSize:12}}>
{[...(dep.gnrHistory||[]),...(dep.gazoleHistory||[])].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10).map((h,i)=>(
<div key={i} style={{display:'flex',justifyContent:'space-between',padding:'2px 0',borderBottom:'1px solid #f1f5f9',color:h.type==='in'?C.green:C.red}}>
<span>{h.type==='in'?'+':'-'}{h.liters}L {h.date}</span>
<span>{h.type==='out'?h.employeeName+' '+h.machineName:fmtMoney(h.pricePerL)+'/L'}</span>
</div>))}
</div></div>))}
{show&&sel&&<Mod title={sel.name||'Nouveau depot'} onClose={close} width={550}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Adresse"><input style={inputStyle} value={sel.address||''} onChange={e=>setSel({...sel,address:e.target.value})}/></Fl>
<Fl label="GPS (lat,lon)"><input style={inputStyle} value={sel._coords?sel._coords.join(','):''} onChange={e=>{const p=parseCoords(e.target.value);setSel({...sel,_coords:p})}}/></Fl>
<h4 style={{marginTop:12}}>Approvisionnement GNR</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Stock (L)"><input type="number" style={inputStyle} value={sel.gnrStock||0} onChange={e=>setSel({...sel,gnrStock:Number(e.target.value)})}/></Fl>
<Fl label="Prix/L"><input type="number" step="0.01" style={inputStyle} value={sel.gnrPrice||0} onChange={e=>setSel({...sel,gnrPrice:Number(e.target.value)})}/></Fl>
</div>
<h4 style={{marginTop:12}}>Approvisionnement Gazole</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Stock (L)"><input type="number" style={inputStyle} value={sel.gazoleStock||0} onChange={e=>setSel({...sel,gazoleStock:Number(e.target.value)})}/></Fl>
<Fl label="Prix/L"><input type="number" step="0.01" style={inputStyle} value={sel.gazolePrice||0} onChange={e=>setSel({...sel,gazolePrice:Number(e.target.value)})}/></Fl>
</div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== MACHINES ========
const MachinesPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const[machinesJd,setMachinesJd]=useState([]);
useEffect(()=>{if(!sb)return;sb.from('machines_jd').select('*').then(({data:jdData})=>{if(jdData)setMachinesJd(jdData)})},[]);
const types=['Raboteuse','Balayeuse','Citerne'];
const open=m=>{setSel(m?{...m}:{id:uid(),name:'',type:'Raboteuse',width:'',fuelConsumption:'',purchasePrice:'',creditMonthly:'',creditEnd:''});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const ms=data.machines||[];const idx=ms.findIndex(m=>m.id===sel.id);const nm=idx>=0?ms.map(m=>m.id===sel.id?sel:m):[...ms,sel];save({...data,machines:nm});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,machines:(data.machines||[]).filter(m=>m.id!==sel.id)});close()};
const driver=mid=>{const e=(data.employees||[]).find(e=>e.machineId===mid);return e?e.name:'-'};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Machines</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
{types.map(t=>{const list=(data.machines||[]).filter(m=>m.type===t);if(!list.length)return null;return(
<div key={t} style={{marginBottom:24}}><h3 style={{color:MC[t],marginBottom:8}}>{t}s</h3>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{list.map(m=>(
<div key={m.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)',borderLeft:'4px solid '+MC[t]}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{m.name}</strong><EBtn onClick={()=>open(m)}/></div>
{t==='Raboteuse'&&m.width&&<div style={{fontSize:13,color:C.dim}}>Largeur: {m.width}</div>}
<div style={{fontSize:13,color:C.dim}}>Chauffeur: {driver(m.id)}</div>
<div style={{fontSize:13,color:C.dim}}>Conso: {m.fuelConsumption||0} L/h</div>
{(()=>{const stat=((data.machineEquipmentStatus||{})[m.id])||{};const miss=Object.values(stat).filter(v=>v==='missing').length;return miss>0?<div style={{fontSize:13,fontWeight:700,color:C.red,marginTop:4}}>⚠ {miss} equipement(s) manquant(s)</div>:null})()}
</div>))}
</div></div>)})}
{show&&sel&&<Mod title={sel.name||'Nouvelle machine'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Type"><select style={inputStyle} value={sel.type} onChange={e=>setSel({...sel,type:e.target.value})}>{types.map(t=><option key={t} value={t}>{t}</option>)}</select></Fl>
{sel.type==='Raboteuse'&&<Fl label="Largeur"><input style={inputStyle} value={sel.width} onChange={e=>setSel({...sel,width:e.target.value})}/></Fl>}
<Fl label="Conso (L/h)"><input type="number" style={inputStyle} value={sel.fuelConsumption} onChange={e=>setSel({...sel,fuelConsumption:e.target.value})}/></Fl>
<Fl label="Liaison John Deere"><select style={inputStyle} value={sel.jdId||''} onChange={e=>setSel({...sel,jdId:e.target.value||undefined})}><option value="">-- Aucune liaison JD --</option>{machinesJd.map(jd=><option key={jd.id} value={jd.id}>{jd.name||jd.id}</option>)}</select></Fl>
<Fl label="Prix achat"><input type="number" style={inputStyle} value={sel.purchasePrice} onChange={e=>setSel({...sel,purchasePrice:e.target.value})}/></Fl>
<Fl label="Credit mensuel"><input type="number" style={inputStyle} value={sel.creditMonthly} onChange={e=>setSel({...sel,creditMonthly:e.target.value})}/></Fl>
<Fl label="Fin credit"><input type="date" style={inputStyle} value={sel.creditEnd||''} onChange={e=>setSel({...sel,creditEnd:e.target.value})}/></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}><h4 style={{margin:'0 0 8px'}}>Couts mensuels</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Assurance (EUR/mois)"><input type="number" style={inputStyle} value={sel.insuranceMonthly||0} onChange={e=>setSel({...sel,insuranceMonthly:Number(e.target.value)})}/></Fl>
<Fl label="CT (EUR/an)"><input type="number" style={inputStyle} value={sel.ctCost||0} onChange={e=>setSel({...sel,ctCost:Number(e.target.value)})}/></Fl>
</div></div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== EQUIPMENT LISTS (per machine type) ========
const EquipmentListsPage=({data,save})=>{
const types=['Raboteuse','Balayeuse','Citerne'];
const[newName,setNewName]=useState({Raboteuse:'',Balayeuse:'',Citerne:''});
const addItem=(type)=>{const nm=(newName[type]||'').trim();if(!nm)return;const nd=JSON.parse(JSON.stringify(data));if(!nd.equipmentLists)nd.equipmentLists={Raboteuse:[],Balayeuse:[],Citerne:[]};if(!nd.equipmentLists[type])nd.equipmentLists[type]=[];nd.equipmentLists[type].push({id:uid(),name:nm});save(nd);setNewName({...newName,[type]:''})};
const delItem=(type,id)=>{if(!confirm('Supprimer cet equipement ?'))return;const nd=JSON.parse(JSON.stringify(data));nd.equipmentLists[type]=((nd.equipmentLists||{})[type]||[]).filter(x=>x.id!==id);save(nd)};
const renameItem=(type,id,name)=>{const nd=JSON.parse(JSON.stringify(data));const arr=((nd.equipmentLists||{})[type]||[]);const idx=arr.findIndex(x=>x.id===id);if(idx>=0){arr[idx]={...arr[idx],name};save(nd)}};
const machinesByType=t=>(data.machines||[]).filter(m=>m.type===t);
return(
<div>
<h2 style={{margin:'0 0 16px'}}>Equipements par type de machine</h2>
<div style={{fontSize:13,color:C.dim,marginBottom:16}}>Definissez la liste des equipements que chaque type de machine doit avoir. Les chauffeurs verront cette liste dans leur espace et pourront signaler les equipements manquants.</div>
{types.map(t=>{const list=((data.equipmentLists||{})[t]||[]);const macs=machinesByType(t);return(
<div key={t} style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,borderLeft:'4px solid '+(MC[t]||C.accent),marginBottom:16}}>
<h3 style={{color:MC[t]||C.accent,margin:'0 0 12px'}}>{t}s ({macs.length} machine{macs.length>1?'s':''})</h3>
{list.length===0&&<div style={{fontSize:14,color:C.dim,marginBottom:8}}>Aucun equipement configure.</div>}
{list.map(eq=>(
<div key={eq.id} style={{display:'flex',gap:6,alignItems:'center',marginBottom:6}}>
<input style={{...inputStyle,flex:1}} value={eq.name} onChange={e=>renameItem(t,eq.id,e.target.value)}/>
<button onClick={()=>delItem(t,eq.id)} style={{...btnStyle(C.red),fontSize:13,padding:'6px 10px'}}>x</button>
</div>))}
<div style={{display:'flex',gap:6,marginTop:8}}>
<input style={{...inputStyle,flex:1}} placeholder="Nouvel equipement..." value={newName[t]} onChange={e=>setNewName({...newName,[t]:e.target.value})} onKeyDown={e=>{if(e.key==='Enter')addItem(t)}}/>
<button onClick={()=>addItem(t)} style={btnStyle(C.accent,true)}>+ Ajouter</button>
</div>
{macs.length>0&&list.length>0&&<div style={{marginTop:12,paddingTop:8,borderTop:'1px dashed '+C.border}}>
<div style={{fontSize:13,fontWeight:700,marginBottom:6,color:C.dim}}>Etat par machine :</div>
{macs.map(m=>{const stat=((data.machineEquipmentStatus||{})[m.id])||{};const missing=list.filter(eq=>stat[eq.id]==='missing');const present=list.filter(eq=>stat[eq.id]==='present').length;return(
<div key={m.id} style={{fontSize:13,marginBottom:4,padding:'4px 8px',background:missing.length>0?'#fef2f2':'#f8fafc',borderRadius:6,border:'1px solid '+(missing.length>0?'#fecaca':C.border)}}>
<strong>{m.name}</strong> <span style={{color:C.dim}}>— {present}/{list.length} presents</span>
{missing.length>0&&<span style={{marginLeft:6,color:C.red,fontWeight:700}}>⚠ Manquants : {missing.map(eq=>eq.name).join(', ')}</span>}
</div>)})}
</div>}
</div>)})}
</div>)};

// ======== TRUCKS ========
const TrucksPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const open=t=>{setSel(t?{...t}:{id:uid(),name:'',fuelPer100:'',ctDate:'',vidangeDate:''});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const ts=data.trucks||[];const idx=ts.findIndex(t=>t.id===sel.id);const nt=idx>=0?ts.map(t=>t.id===sel.id?sel:t):[...ts,sel];save({...data,trucks:nt});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,trucks:(data.trucks||[]).filter(t=>t.id!==sel.id)});close()};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Camions</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.trucks||[]).map(t=>(
<div key={t.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{t.name}</strong><EBtn onClick={()=>open(t)}/></div>
<div style={{fontSize:13,color:C.dim}}>Conso: {t.fuelPer100||0} L/100km</div>
<div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}><CtBadge dateStr={t.ctDate} label="CT"/><CtBadge dateStr={t.vidangeDate} label="Vidange"/></div>
</div>))}
</div>
{show&&sel&&<Mod title={sel.name||'Nouveau camion'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Conso (L/100km)"><input type="number" style={inputStyle} value={sel.fuelPer100} onChange={e=>setSel({...sel,fuelPer100:e.target.value})}/></Fl>
<Fl label="Date CT"><input type="date" style={inputStyle} value={sel.ctDate||''} onChange={e=>setSel({...sel,ctDate:e.target.value})}/></Fl>
<Fl label="Date vidange"><input type="date" style={inputStyle} value={sel.vidangeDate||''} onChange={e=>setSel({...sel,vidangeDate:e.target.value})}/></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}><h4 style={{margin:'0 0 8px'}}>Couts mensuels</h4>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Credit mensuel"><input type="number" style={inputStyle} value={sel.creditMonthly||0} onChange={e=>setSel({...sel,creditMonthly:Number(e.target.value)})}/></Fl>
<Fl label="Assurance (EUR/mois)"><input type="number" style={inputStyle} value={sel.insuranceMonthly||0} onChange={e=>setSel({...sel,insuranceMonthly:Number(e.target.value)})}/></Fl>
<Fl label="CT (EUR/an)"><input type="number" style={inputStyle} value={sel.ctCost||0} onChange={e=>setSel({...sel,ctCost:Number(e.target.value)})}/></Fl>
</div></div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== CARS ========
const CarsPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const open=c=>{setSel(c?{...c}:{id:uid(),name:'',plate:'',ctDate:'',vidangeDate:''});setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const cs=data.cars||[];const idx=cs.findIndex(c=>c.id===sel.id);const nc=idx>=0?cs.map(c=>c.id===sel.id?sel:c):[...cs,sel];save({...data,cars:nc});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,cars:(data.cars||[]).filter(c=>c.id!==sel.id)});close()};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Voitures</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.cars||[]).map(c=>(
<div key={c.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{c.name}</strong><EBtn onClick={()=>open(c)}/></div>
<div style={{fontSize:13,color:C.dim}}>Plaque: {c.plate||'-'}</div>
<div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}><CtBadge dateStr={c.ctDate} label="CT"/><CtBadge dateStr={c.vidangeDate} label="Vidange"/></div>
</div>))}
</div>
{show&&sel&&<Mod title={sel.name||'Nouveau vehicule'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Immatriculation"><input style={inputStyle} value={sel.plate||''} onChange={e=>setSel({...sel,plate:e.target.value})}/></Fl>
<Fl label="Date CT"><input type="date" style={inputStyle} value={sel.ctDate||''} onChange={e=>setSel({...sel,ctDate:e.target.value})}/></Fl>
<Fl label="Date vidange"><input type="date" style={inputStyle} value={sel.vidangeDate||''} onChange={e=>setSel({...sel,vidangeDate:e.target.value})}/></Fl>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== EMPLOYEES ========
const EmployeesPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);
const genLogin=n=>(n||'').toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
const open=e=>{if(e){setSel({...e,_coords:e._coords||null,password:(data.empPasswords||{})[e.id]||''})}else{setSel({id:uid(),name:'',role:'employee',address:'',_coords:null,hourlySalary:'',machineId:'',truckId:'',password:''})}setShow(true)};
const close=()=>{setShow(false);setSel(null)};
const doSave=()=>{const{password,...emp}=sel;emp.login=genLogin(emp.name);const es=data.employees||[];const idx=es.findIndex(e=>e.id===emp.id);const ne=idx>=0?es.map(e=>e.id===emp.id?emp:e):[...es,emp];const ps={...(data.empPasswords||{})};if(password)ps[emp.id]=password;else delete ps[emp.id];save({...data,employees:ne,empPasswords:ps});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;const ps={...(data.empPasswords||{})};delete ps[sel.id];save({...data,employees:(data.employees||[]).filter(e=>e.id!==sel.id),empPasswords:ps});close()};
const machName=mid=>{const m=(data.machines||[]).find(m=>m.id===mid);return m?m.name:'-'};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Employes</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.employees||[]).map(e=>{const has=!!(data.empPasswords||{})[e.id];return(
<div key={e.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',alignItems:'center',gap:12}}>
<div style={{width:40,height:40,borderRadius:'50%',background:C.accent,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:18,flexShrink:0}}>{(e.name||'?')[0].toUpperCase()}</div>
<div style={{flex:1,minWidth:0}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{e.name}</strong><EBtn onClick={()=>open(e)}/></div>
<div style={{fontSize:13,color:C.dim}}>{e.salaryType==='monthly'?fmtMoney(e.monthlySalary||0)+'/mois':fmtMoney(e.hourlySalary||0)+'/h'}</div>
</div></div>
<div style={{fontSize:13,color:C.dim,marginTop:6}}>Machine: {machName(e.machineId)}</div>
<div style={{marginTop:6}}>{has?<Bg text="Actif" color={C.green}/>:<Bg text="Pas d'acces" color={C.red}/>}</div>
</div>)})}
</div>
{show&&sel&&<Mod title={sel.name||'Nouvel employe'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Role"><select style={inputStyle} value={sel.role} onChange={e=>setSel({...sel,role:e.target.value})}><option value="employee">Employe</option><option value="mechanic">Mecanicien</option></select></Fl>
<Fl label="Adresse"><input style={inputStyle} value={sel.address||''} onChange={e=>setSel({...sel,address:e.target.value})}/></Fl>
<Fl label="GPS domicile (lat,lon)"><input style={inputStyle} value={sel._coords?sel._coords.join(','):''} onChange={e=>{const p=parseCoords(e.target.value);setSel({...sel,_coords:p})}} placeholder="48.8566,2.3522"/></Fl>
<Fl label="Type de salaire"><select style={inputStyle} value={sel.salaryType||'hourly'} onChange={e=>setSel({...sel,salaryType:e.target.value})}><option value="hourly">Horaire (pointage)</option><option value="monthly">Mensualise</option></select></Fl>
{(sel.salaryType||'hourly')==='hourly'&&<Fl label="Taux horaire"><input type="number" style={inputStyle} value={sel.hourlySalary} onChange={e=>setSel({...sel,hourlySalary:e.target.value})}/></Fl>}
{sel.salaryType==='monthly'&&<Fl label="Salaire mensuel brut"><input type="number" style={inputStyle} value={sel.monthlySalary||0} onChange={e=>setSel({...sel,monthlySalary:Number(e.target.value)})}/></Fl>}
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Panier repas (EUR/jour)"><input type="number" style={inputStyle} value={sel.mealAllowance||12} onChange={e=>setSel({...sel,mealAllowance:Number(e.target.value)})}/></Fl>
<Fl label="Charges patronales (%)"><input type="number" style={inputStyle} value={sel.chargesRate||45} onChange={e=>setSel({...sel,chargesRate:Number(e.target.value)})}/></Fl>
</div>
<Fl label="Machine"><select style={inputStyle} value={sel.machineId||''} onChange={e=>setSel({...sel,machineId:e.target.value})}><option value="">-- Aucune --</option>{(data.machines||[]).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Fl>
<Fl label="Camion"><select style={inputStyle} value={sel.truckId||''} onChange={e=>setSel({...sel,truckId:e.target.value})}><option value="">-- Aucun --</option>{(data.trucks||[]).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h4 style={{margin:'0 0 8px'}}>Acces salarie</h4>
<Fl label="Identifiant"><input style={{...inputStyle,background:'#f0f0f0'}} readOnly value={genLogin(sel.name)}/></Fl>
<Fl label="Mot de passe"><input style={inputStyle} value={sel.password||''} onChange={e=>setSel({...sel,password:e.target.value})} placeholder="Vide = pas d'acces"/></Fl></div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== CLIENTS ========
const ClientsPage=({data,save})=>{
const[sel,setSel]=useState(null);const[show,setShow]=useState(false);const[agIn,setAgIn]=useState('');
const open=c=>{setSel(c?{...c,agencies:[...(c.agencies||[])],siteManagers:[...(c.siteManagers||[]).map(s=>({...s}))]}:{id:uid(),name:'',forfaitType:'standard',agencies:[],siteManagers:[]});setShow(true)};
const close=()=>{setShow(false);setSel(null);setAgIn('')};
const doSave=()=>{const cs=data.clients||[];const idx=cs.findIndex(c=>c.id===sel.id);const nc=idx>=0?cs.map(c=>c.id===sel.id?sel:c):[...cs,sel];save({...data,clients:nc});close()};
const delItem=()=>{if(!confirm('Supprimer ?'))return;save({...data,clients:(data.clients||[]).filter(c=>c.id!==sel.id)});close()};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}><h2 style={{margin:0}}>Clients</h2><button style={btnStyle(C.accent,true)} onClick={()=>open(null)}>+ Ajouter</button></div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:16}}>
{(data.clients||[]).map(c=>(
<div key={c.id} style={{background:C.card,borderRadius:12,padding:16,boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>{c.name}</strong><EBtn onClick={()=>open(c)}/></div>
<div style={{marginTop:6}}><Bg text={c.forfaitType==='specific'?'Specifique':'Standard'} color={c.forfaitType==='specific'?C.purple:C.accent}/></div>
<div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:6}}>{(c.agencies||[]).map((a,i)=><span key={i} style={{fontSize:11,padding:'1px 6px',borderRadius:6,background:'#eee'}}>{a}</span>)}</div>
<div style={{fontSize:13,color:C.dim,marginTop:4}}>{(c.siteManagers||[]).length} chef(s) chantier</div>
</div>))}
</div>
{show&&sel&&<Mod title={sel.name||'Nouveau client'} onClose={close}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<Fl label="Type forfait"><select style={inputStyle} value={sel.forfaitType} onChange={e=>setSel({...sel,forfaitType:e.target.value})}><option value="standard">Standard</option><option value="specific">Specifique</option></select></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}><h4 style={{margin:'0 0 8px'}}>Agences</h4>
<div style={{display:'flex',gap:6,marginBottom:8}}><input style={{...inputStyle,flex:1}} value={agIn} onChange={e=>setAgIn(e.target.value)} placeholder="Nom agence" onKeyDown={e=>{if(e.key==='Enter'&&agIn.trim()){setSel({...sel,agencies:[...sel.agencies,agIn.trim()]});setAgIn('')}}}/><button style={btnStyle(C.accent)} onClick={()=>{if(agIn.trim()){setSel({...sel,agencies:[...sel.agencies,agIn.trim()]});setAgIn('')}}}>+</button></div>
{sel.agencies.map((a,i)=><div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0'}}><span>{a}</span><button style={{background:'none',border:'none',cursor:'pointer',color:C.red}} onClick={()=>setSel({...sel,agencies:sel.agencies.filter((_,j)=>j!==i)})}>x</button></div>)}
</div>
<div style={{borderTop:'1px solid #eee',marginTop:12,paddingTop:8}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}><h4 style={{margin:0}}>Chefs chantier</h4><button style={btnStyle(C.accent)} onClick={()=>setSel({...sel,siteManagers:[...sel.siteManagers,{name:'',phone:'',agency:''}]})}>+</button></div>
{sel.siteManagers.map((s,i)=>(
<div key={i} style={{display:'flex',gap:6,alignItems:'center',marginBottom:6,flexWrap:'wrap'}}>
<input style={{...inputStyle,flex:1,minWidth:80}} placeholder="Nom" value={s.name} onChange={e=>{const ns=[...sel.siteManagers];ns[i]={...ns[i],name:e.target.value};setSel({...sel,siteManagers:ns})}}/>
<input style={{...inputStyle,flex:1,minWidth:80}} placeholder="Tel" value={s.phone} onChange={e=>{const ns=[...sel.siteManagers];ns[i]={...ns[i],phone:e.target.value};setSel({...sel,siteManagers:ns})}}/>
<input style={{...inputStyle,flex:1,minWidth:80}} placeholder="Agence" value={s.agency||''} onChange={e=>{const ns=[...sel.siteManagers];ns[i]={...ns[i],agency:e.target.value};setSel({...sel,siteManagers:ns})}}/>
<button style={{background:'none',border:'none',cursor:'pointer',color:C.red}} onClick={()=>setSel({...sel,siteManagers:sel.siteManagers.filter((_,j)=>j!==i)})}>x</button>
</div>))}
</div>
<div style={{display:'flex',gap:8,marginTop:16}}><button style={btnStyle(C.accent,true)} onClick={doSave}>Enregistrer</button><button style={btnStyle(C.red)} onClick={delItem}>Supprimer</button></div>
</Mod>}
</div>)};

// ======== FORFAITS ========
const ForfaitsPage=({data,save})=>{
const clients=(data.clients||[]).filter(c=>c.forfaitType==='specific');
const[tab,setTab]=useState('standard');
const rabWidths=[...new Set((data.machines||[]).filter(m=>m.type==='Raboteuse').map(m=>m.width||'').filter(Boolean))];
if(rabWidths.length===0)rabWidths.push('');
const rabDurees=['2h','4h','6h','8h','Transfert'];
const balDurees=['2h','4h','6h','8h','Transfert'];
const citOpts=['Avec chauffeur','Sans chauffeur'];
const citDurees=['Demi-journee','Journee','Transfert'];
const getVal=(key,dur)=>(data.forfaits[key]||{})[dur]||'';
const setVal=(key,dur,v)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.forfaits)nd.forfaits={};if(!nd.forfaits[key])nd.forfaits[key]={};nd.forfaits[key][dur]=Number(v)||0;save(nd)};
const prefix=tab;
const cellStyle={padding:'4px 6px',border:'1px solid '+C.border,textAlign:'center'};
const hdrStyle={...cellStyle,background:C.bg,fontWeight:600,fontSize:12};
return(
<div>
<h2 style={{marginBottom:16}}>Forfaits</h2>
<div style={{display:'flex',gap:4,marginBottom:16,flexWrap:'wrap'}}>
<button onClick={()=>setTab('standard')} style={btnStyle(C.accent,tab==='standard')}>Standard</button>
{clients.map(c=><button key={c.id} onClick={()=>setTab(c.id)} style={btnStyle(C.purple,tab===c.id)}>{c.name}</button>)}
</div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:16}}>
<h3 style={{color:MC.Raboteuse,marginBottom:8}}>Raboteuses</h3>
<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
<thead><tr><th style={hdrStyle}>Largeur</th>{rabDurees.map(d=><th key={d} style={hdrStyle}>{d}</th>)}</tr></thead>
<tbody>{rabWidths.map(w=>{const key=prefix+'_rab_'+w;return(
<tr key={w}><td style={hdrStyle}>{w||'N/A'}</td>
{rabDurees.map(d=><td key={d} style={cellStyle}><input type="number" style={{width:70,border:'1px solid #ddd',borderRadius:4,padding:2,textAlign:'center'}} value={getVal(key,d)} onChange={e=>setVal(key,d,e.target.value)}/></td>)}
</tr>)})}</tbody></table></div></div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:16}}>
<h3 style={{color:MC.Balayeuse,marginBottom:8}}>Balayeuses</h3>
<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
<thead><tr><th style={hdrStyle}></th>{balDurees.map(d=><th key={d} style={hdrStyle}>{d}</th>)}</tr></thead>
<tbody><tr><td style={hdrStyle}>Prix</td>{balDurees.map(d=>{const key=prefix+'_bal';return(<td key={d} style={cellStyle}><input type="number" style={{width:70,border:'1px solid #ddd',borderRadius:4,padding:2,textAlign:'center'}} value={getVal(key,d)} onChange={e=>setVal(key,d,e.target.value)}/></td>)})}</tr></tbody></table></div></div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border}}>
<h3 style={{color:MC.Citerne,marginBottom:8}}>Citernes</h3>
<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}>
<thead><tr><th style={hdrStyle}>Option</th>{citDurees.map(d=><th key={d} style={hdrStyle}>{d}</th>)}</tr></thead>
<tbody>{citOpts.map(o=>{const key=prefix+'_cit_'+o;return(
<tr key={o}><td style={hdrStyle}>{o}</td>
{citDurees.map(d=><td key={d} style={cellStyle}><input type="number" style={{width:70,border:'1px solid #ddd',borderRadius:4,padding:2,textAlign:'center'}} value={getVal(key,d)} onChange={e=>setVal(key,d,e.target.value)}/></td>)}
</tr>)})}</tbody></table></div></div>
<div style={{marginTop:8,fontSize:12,color:C.dim}}>Majoration nuit: +{data.nightPct||30}% (configurable dans Parametres)</div>
</div>)};

// ======== SETTINGS ========
const SettingsPage=({data,save})=>{
const[au,setAu]=useState(data.adminUser||'admin');const[ap,setAp]=useState(data.adminPass||'admin');
const[fp,setFp]=useState(data.fuelPrice||1.72);const[np,setNp]=useState(data.nightPct||30);
const[nStart,setNStart]=useState(data.nightStart||'21:00');const[nEnd,setNEnd]=useState(data.nightEnd||'06:00');
const[tpDepartMin,setTpDepartMin]=useState(data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART);
const[tpArriveeMin,setTpArriveeMin]=useState(data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE);
const[tolMin,setTolMin]=useState(data.toleranceMinutes!=null?data.toleranceMinutes:TOLERANCE_MINUTES);
const[wdpm,setWdpm]=useState(data.workDaysPerMonth||22);
const[mRent,setMRent]=useState(data.monthlyRent||0);
const[mAdmin,setMAdmin]=useState(data.monthlyAdmin||0);
const[mIRC,setMIRC]=useState(data.monthlyInsuranceRC||0);
const[yStart,setYStart]=useState(data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1)));
const[weeklyH,setWeeklyH]=useState(data.weeklyHoursNormal||35);
const[ot25,setOt25]=useState(data.overtime25Threshold||35);
const[ot50,setOt50]=useState(data.overtime50Threshold||43);
const[refHpd,setRefHpd]=useState(data.refHoursPerDay||1);
const[paniersP,setPaniersP]=useState(data.paniersPrice!=null?data.paniersPrice:12);
const[restoP,setRestoP]=useState(data.restoPrice!=null?data.restoPrice:15);
const[apiKey,setApiKey]=useState(data.anthropicApiKey||'');
const[companyCtx,setCompanyCtx]=useState(data.companyContext||'');
const doSave=()=>{save({...data,adminUser:au,adminPass:ap,fuelPrice:Number(fp),nightPct:Number(np),nightStart:nStart||'21:00',nightEnd:nEnd||'06:00',tempsPlusDepart:Number(tpDepartMin),tempsPlusArrivee:Number(tpArriveeMin),toleranceMinutes:Number(tolMin),workDaysPerMonth:Number(wdpm),monthlyRent:Number(mRent),monthlyAdmin:Number(mAdmin),monthlyInsuranceRC:Number(mIRC),yearStart:yStart,weeklyHoursNormal:Number(weeklyH),overtime25Threshold:Number(ot25),overtime50Threshold:Number(ot50),refHoursPerDay:Number(refHpd),paniersPrice:Number(paniersP),restoPrice:Number(restoP),anthropicApiKey:apiKey,companyContext:companyCtx});alert('Enregistre')};
const genLogin=n=>(n||'').toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
return(
<div>
<h2 style={{marginBottom:16}}>Parametres</h2>
<div style={{background:C.card,borderRadius:12,padding:20,border:'1px solid '+C.border,maxWidth:600}}>
<h3 style={{marginTop:0}}>Compte admin</h3>
<Fl label="Identifiant"><input style={inputStyle} value={au} onChange={e=>setAu(e.target.value)}/></Fl>
<Fl label="Mot de passe"><input style={inputStyle} type="password" value={ap} onChange={e=>setAp(e.target.value)}/></Fl>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Tarification</h3>
<Fl label="Prix carburant (EUR/L)"><input type="number" step="0.01" style={inputStyle} value={fp} onChange={e=>setFp(e.target.value)}/></Fl>
<Fl label="Majoration nuit (%)"><input type="number" style={inputStyle} value={np} onChange={e=>setNp(e.target.value)}/></Fl>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Debut plage nuit"><input type="time" style={inputStyle} value={nStart} onChange={e=>setNStart(e.target.value)}/></Fl>
<Fl label="Fin plage nuit"><input type="time" style={inputStyle} value={nEnd} onChange={e=>setNEnd(e.target.value)}/></Fl>
</div>
<div style={{fontSize:11,color:C.dim,marginTop:-6,marginBottom:8}}>Plage utilisee pour le calcul automatique des heures de nuit dans l'onglet Heures (par defaut 21h00 - 06h00).</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Panier repas (EUR)"><input type="number" step="0.01" style={inputStyle} value={paniersP} onChange={e=>setPaniersP(e.target.value)}/></Fl>
<Fl label="Repas Resto (EUR)"><input type="number" step="0.01" style={inputStyle} value={restoP} onChange={e=>setRestoP(e.target.value)}/></Fl>
</div></div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Constantes horaires</h3>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Temps en plus depart (min)"><input type="number" style={inputStyle} value={tpDepartMin} onChange={e=>setTpDepartMin(e.target.value)}/></Fl>
<Fl label="Temps en plus arrivee (min)"><input type="number" style={inputStyle} value={tpArriveeMin} onChange={e=>setTpArriveeMin(e.target.value)}/></Fl>
<Fl label="Tolerance (min)"><input type="number" style={inputStyle} value={tolMin} onChange={e=>setTolMin(e.target.value)}/></Fl>
</div></div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Heures supplementaires</h3>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Heures normales/semaine"><input type="number" style={inputStyle} value={weeklyH} onChange={e=>setWeeklyH(e.target.value)}/></Fl>
<Fl label="Seuil supp 25% (h)"><input type="number" style={inputStyle} value={ot25} onChange={e=>setOt25(e.target.value)}/></Fl>
<Fl label="Seuil supp 50% (h)"><input type="number" style={inputStyle} value={ot50} onChange={e=>setOt50(e.target.value)}/></Fl>
<Fl label="Temps ref/jour (h)"><input type="number" step="0.25" style={inputStyle} value={refHpd} onChange={e=>setRefHpd(e.target.value)}/></Fl>
</div></div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Couts fixes entreprise</h3>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
<Fl label="Jours ouvres/mois"><input type="number" style={inputStyle} value={wdpm} onChange={e=>setWdpm(e.target.value)}/></Fl>
<Fl label="Loyer/credit depot (EUR/mois)"><input type="number" style={inputStyle} value={mRent} onChange={e=>setMRent(e.target.value)}/></Fl>
<Fl label="Frais admin/comptable (EUR/mois)"><input type="number" style={inputStyle} value={mAdmin} onChange={e=>setMAdmin(e.target.value)}/></Fl>
<Fl label="Assurance RC pro (EUR/mois)"><input type="number" style={inputStyle} value={mIRC} onChange={e=>setMIRC(e.target.value)}/></Fl>
</div>
<Fl label="Debut exercice"><input type="date" style={inputStyle} value={yStart} onChange={e=>setYStart(e.target.value)}/></Fl>
</div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Assistant IA (Claude)</h3>
<div style={{fontSize:12,color:C.dim,marginBottom:8}}>Clé API Anthropic — obtenez-la sur <b>console.anthropic.com</b> (gratuit jusqu'à 5$)</div>
<Fl label="Clé API Anthropic (sk-ant-...)">
<input type="password" style={inputStyle} value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-ant-api03-..."/>
</Fl>
{apiKey&&<div style={{fontSize:12,color:C.green,marginTop:4}}>✓ Clé renseignée — chatbot actif</div>}
{!apiKey&&<div style={{fontSize:12,color:C.orange,marginTop:4}}>⚠ Sans clé, le bouton 💬 ne fonctionnera pas</div>}
<div style={{marginTop:16,paddingTop:12,borderTop:'1px dashed #ddd'}}>
<div style={{fontSize:12,color:C.dim,marginBottom:6}}><b>Contexte entreprise</b> — explique comment SONECO fonctionne. Claude utilisera ces infos pour mieux te repondre.</div>
<div style={{fontSize:11,color:C.muted,marginBottom:6,lineHeight:1.5}}>
Suggestions de ce que tu peux ecrire :<br/>
- Activite principale et clients types<br/>
- Horaires habituels (debut journee, pause, fin)<br/>
- Particularites tarifaires (qui paye quoi, marges, urgences)<br/>
- Saisonnalite (haute saison, basse saison, conges)<br/>
- Process de validation (qui valide les pointages, quand)<br/>
- Equipement specifique (machine pour tel type de chantier)<br/>
- Habitudes des chauffeurs (X travaille toujours sur Y, etc.)<br/>
- Regles internes (entretien hebdo, plein le matin, etc.)
</div>
<textarea style={{...inputStyle,minHeight:160,fontFamily:'inherit',resize:'vertical',fontSize:13,lineHeight:1.5}} value={companyCtx} onChange={e=>setCompanyCtx(e.target.value)} placeholder="Ex: SONECO fait du rabotage routier pour les TP. Nos chauffeurs commencent generalement vers 6h30 et finissent vers 16h30. Franck est specialise sur la 100fi. Le client LABTP est notre plus gros, on est prioritaires. Les pleins se font le soir au depot 16. ..."/>
<div style={{fontSize:11,color:C.muted,marginTop:4}}>{companyCtx.length} caracteres · ecrit comme tu parles, pas besoin de formatage</div>
</div>
</div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Acces employes</h3>
{(data.employees||[]).map(e=>{const has=!!(data.empPasswords||{})[e.id];return(
<div key={e.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:'1px solid #f0f0f0'}}>
<div><span style={{fontWeight:500}}>{e.name}</span><span style={{fontSize:12,color:C.muted,marginLeft:8}}>({genLogin(e.name)})</span></div>
<span style={{fontSize:12,padding:'2px 8px',borderRadius:8,background:has?'#d4edda':'#f8d7da',color:has?'#155724':'#721c24'}}>{has?'Actif':'Inactif'}</span>
</div>)})}
</div>
<div style={{borderTop:'1px solid #eee',marginTop:16,paddingTop:12}}><h3>Sauvegarde / Export</h3>
<div style={{fontSize:12,color:C.dim,marginBottom:8}}>Telecharge toutes les donnees de l'app (referentiel, planning, pointages, rapports Wirtgen/JD, pannes, stock...) dans un fichier JSON.</div>
<button onClick={()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='roadmanager_export_'+fmtDateISO(new Date())+'.json';a.click();URL.revokeObjectURL(url)}} style={{...btnStyle('#0891b2',true)}}>⬇ Exporter les donnees (JSON)</button>
</div>
<button onClick={doSave} style={{...btnStyle(C.accent,true),marginTop:16}}>Enregistrer</button>
</div></div>)};

// ======== EMPLOYEE VIEW ========
const EmployeeView=({data,save,empId,onLogout})=>{
const emp=(data.employees||[]).find(e=>e.id===empId);
const[view,setView]=useState('Jour');const[offset,setOffset]=useState(0);
const[editTE,setEditTE]=useState(null);
const[showInbox,setShowInbox]=useState(false);
const myMsgs=((data.messages||[]).filter(m=>m.toEmpId===empId)).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
const unreadCount=myMsgs.filter(m=>!m.read).length;
const openInbox=()=>{setShowInbox(true);if(unreadCount>0){const nd=JSON.parse(JSON.stringify(data));(nd.messages||[]).forEach(m=>{if(m.toEmpId===empId&&!m.read)m.read=true});save(nd)}};
const[showManual,setShowManual]=useState(false);
const[manDate,setManDate]=useState(fmtDateISO(new Date()));
const[manStart,setManStart]=useState('');
const[manEnd,setManEnd]=useState('');
const[manPause,setManPause]=useState(0);
const[manBreakStart,setManBreakStart]=useState('12:00');
const[manBreakEnd,setManBreakEnd]=useState('13:00');
const[manMeal,setManMeal]=useState('PANIER');
const[manAbsence,setManAbsence]=useState('');
const[manNight,setManNight]=useState(0);
const[manRequestEnd,setManRequestEnd]=useState('');
const[showRdv,setShowRdv]=useState(false);
const[rdvType,setRdvType]=useState('rdv');
const[rdvDate,setRdvDate]=useState('');
const[rdvDateFin,setRdvDateFin]=useState('');
const[rdvTime,setRdvTime]=useState('');
const[rdvMotif,setRdvMotif]=useState('');
const[rdvAbsType,setRdvAbsType]=useState('conge');
const submitRdv=()=>{if(!rdvDate){alert('Date requise');return}if(rdvType==='rdv'&&!rdvTime){alert('Heure requise');return}const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntries)nd.timeEntries=[];if(rdvType==='rdv'){const existing=nd.timeEntries.findIndex(t=>t.empId===empId&&t.date===rdvDate);if(existing>=0){nd.timeEntries[existing].requestedEndTime=rdvTime;nd.timeEntries[existing].requestedEndMotif=rdvMotif}else{nd.timeEntries.push({id:uid(),empId,date:rdvDate,type:'pending',startTime:'',endTime:'',pauseStart:null,pauseEnd:null,pauseMin:0,createdAt:new Date().toISOString(),breakStart:'12:00',breakEnd:'13:00',mealType:'',absenceType:'',nightHours:0,requestedEndTime:rdvTime,requestedEndMotif:rdvMotif})}}else{const dStart=new Date(rdvDate);const dEnd=new Date(rdvDateFin||rdvDate);if(dEnd<dStart){alert('Date fin doit etre apres date debut');return}const d=new Date(dStart);while(d<=dEnd){const ds=fmtDateISO(d);const existing=nd.timeEntries.findIndex(t=>t.empId===empId&&t.date===ds);const entry={id:existing>=0?nd.timeEntries[existing].id:uid(),empId,date:ds,type:'absence',startTime:'',endTime:'',pauseStart:null,pauseEnd:null,pauseMin:0,createdAt:new Date().toISOString(),breakStart:'',breakEnd:'',mealType:'',absenceType:rdvAbsType,nightHours:0,requestedEndTime:'',requestedEndMotif:rdvMotif||rdvAbsType};if(existing>=0)nd.timeEntries[existing]=entry;else nd.timeEntries.push(entry);d.setDate(d.getDate()+1)}}save(nd);setShowRdv(false);setRdvDate('');setRdvDateFin('');setRdvTime('');setRdvMotif('');setRdvAbsType('conge');alert(rdvType==='rdv'?'Demande de debauche envoyee !':'Absence enregistree !')};
const[showPanne,setShowPanne]=useState(false);
const[panneEquip,setPanneEquip]=useState('');
const[panneEquipType,setPanneEquipType]=useState('machine');
const[panneSev,setPanneSev]=useState('normal');
const[panneDesc,setPanneDesc]=useState('');
const[showTakePart,setShowTakePart]=useState(false);
const[takePartType,setTakePartType]=useState('');
const[takePartId,setTakePartId]=useState('');
const[takePartQte,setTakePartQte]=useState(1);
const[takePartReason,setTakePartReason]=useState('');
const allEquipEmp=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'machine'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'camion'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'voiture'}))];
const submitPanne=()=>{if(!panneEquip||!panneDesc){alert('Equipement et description requis');return}const nd=JSON.parse(JSON.stringify(data));if(!nd.panneReports)nd.panneReports=[];const eq=allEquipEmp.find(x=>x.id===panneEquip);const rep={id:uid(),date:fmtDateISO(new Date()),reportedBy:empId,severity:panneSev,status:'new',description:panneDesc};if(eq){if(eq.t==='machine')rep.machineId=eq.id;else if(eq.t==='camion')rep.truckId=eq.id;else rep.carId=eq.id}nd.panneReports.push(rep);save(nd);setShowPanne(false);setPanneEquip('');setPanneDesc('');setPanneSev('normal');alert('Panne signalee !')};
const[takePartEquip,setTakePartEquip]=useState('');
const empMachines=useMemo(()=>{const today2=fmtDateISO(new Date());const todayJobs=(data.jobs||[]).filter(j=>j.employeeId===empId&&j.date===today2);const machIds=[...new Set(todayJobs.map(j=>j.machineId).filter(Boolean))];const truckId=emp?emp.truckId:null;return[...machIds.map(id=>{const m=(data.machines||[]).find(x=>x.id===id);return m?{id:m.id,name:m.name,t:'machine'}:null}).filter(Boolean),...(truckId?[{id:truckId,name:((data.trucks||[]).find(t=>t.id===truckId)||{}).name||'Camion',t:'camion'}]:[])]},[data,empId,emp]);
const availPartsForEmp=useMemo(()=>(data.parts||[]).filter(p=>p.quantity>0&&(!takePartEquip||(p.compatibleWith||[]).length===0||(p.compatibleWith||[]).includes(takePartEquip))),[data.parts,takePartEquip]);
const submitTakePart=()=>{if(!takePartId){alert('Choisir une piece');return}const nd=JSON.parse(JSON.stringify(data));const part=(nd.parts||[]).find(p=>p.id===takePartId);if(!part){alert('Piece non trouvee');return}if(part.quantity<takePartQte){alert('Stock insuffisant (dispo: '+part.quantity+')');return}part.quantity-=takePartQte;if(!part.history)part.history=[];part.history.unshift({type:'out',quantity:takePartQte,date:fmtDateISO(new Date()),reason:takePartReason||'Prise par chauffeur',by:empId});part.history=part.history.slice(0,50);if(!nd.interventions)nd.interventions=[];const eq=takePartEquip?allEquipEmp.find(x=>x.id===takePartEquip):null;const inter={id:uid(),date:fmtDateISO(new Date()),type:'changement_piece',description:'Piece prise par '+(emp?emp.name:'chauffeur')+': '+part.name+(takePartReason?' - '+takePartReason:''),employeeId:empId,partsUsed:[{partId:part.id,partName:part.name,quantity:takePartQte,unitPrice:part.unitPrice,totalPrice:takePartQte*part.unitPrice}],laborHours:0,laborCost:0,totalCost:takePartQte*part.unitPrice,status:'done',notes:'Auto-cree depuis espace chauffeur'};if(eq){if(eq.t==='machine')inter.machineId=eq.id;else if(eq.t==='camion')inter.truckId=eq.id;else inter.carId=eq.id}nd.interventions.push(inter);save(nd);setShowTakePart(false);setTakePartId('');setTakePartQte(1);setTakePartReason('');setTakePartEquip('');setTakePartType('');alert('Piece prise du stock !')};
const today=fmtDateISO(new Date());
const dayEntries=(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date===today);
// Detection d'un shift de nuit en cours (ouvert hier, qu'il faut pouvoir fermer ce matin)
const openShift=(data.timeEntries||[]).filter(t=>t.empId===empId&&t.startTime&&!t.endTime&&t.type!=='absence'&&t.type!=='pending').sort((a,b)=>(b.date+(b.startTime||'')).localeCompare(a.date+(a.startTime||'')))[0];
// lastEntry = shift en cours (peut etre d'un jour anterieur si shift de nuit), sinon dernier de la journee
const lastEntry=openShift||dayEntries[dayEntries.length-1];
const status=!lastEntry||lastEntry.type==='done'?'off':lastEntry.type==='pause_start'?'pause':'on';
const isNightShift=lastEntry&&lastEntry.date!==today&&lastEntry.type!=='done';
const doTime=(type)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntries)nd.timeEntries=[];const now=new Date();const time=pad2(now.getHours())+':'+pad2(now.getMinutes());
if(type==='start'){nd.timeEntries.push({id:uid(),empId,date:today,type:'start',startTime:time,endTime:null,pauseStart:null,pauseEnd:null,pauseMin:0,createdAt:new Date().toISOString(),breakStart:'',breakEnd:'',mealType:'PANIER',absenceType:'',nightHours:0})}
else if(type==='pause_start'&&lastEntry){const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.type='pause_start';e.pauseStart=time;e.breakStart=time}}
else if(type==='resume'&&lastEntry){const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.type='start';if(e.pauseStart){e.pauseMin=(e.pauseMin||0)+calcDiffMin(e.pauseStart,time)}e.pauseEnd=time;e.breakEnd=time;e.pauseStart=null}}
else if(type==='done'&&lastEntry){const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.type='done';e.endTime=time;if(lastEntry.date!==today)e.endDate=today;if(e.pauseStart){e.pauseMin=(e.pauseMin||0)+calcDiffMin(e.pauseStart,time);e.pauseStart=null}}}
save(nd)};
const saveManual=()=>{if(!manAbsence&&(!manStart||!manEnd))return;let calcPause=Number(manPause)||0;if(manBreakStart&&manBreakEnd){const bp=calcDiffMin(manBreakStart,manBreakEnd);if(bp>0)calcPause=bp}let crossesMidnight=false;if(manStart&&manEnd){const totalMin=calcDiffMin(manStart,manEnd);const[sh,sm]=manStart.split(':').map(Number);const[eh,em]=manEnd.split(':').map(Number);crossesMidnight=(eh*60+em)<(sh*60+sm);if(totalMin===0){alert('Embauche et debauche identiques');return}if(calcPause>=totalMin){alert('Pause trop longue');return}}const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntries)nd.timeEntries=[];const existing=nd.timeEntries.findIndex(t=>t.empId===empId&&t.date===manDate&&!t.endTime);const entry={id:existing>=0?nd.timeEntries[existing].id:uid(),empId,date:manDate,type:manAbsence?'absence':'done',startTime:manStart||'',endTime:manEnd||'',pauseStart:null,pauseEnd:null,pauseMin:calcPause,createdAt:new Date().toISOString(),breakStart:manBreakStart,breakEnd:manBreakEnd,mealType:manMeal,absenceType:manAbsence,nightHours:Number(manNight)||0,requestedEndTime:manRequestEnd||''};if(crossesMidnight){const nextDay=new Date(manDate);nextDay.setDate(nextDay.getDate()+1);entry.endDate=fmtDateISO(nextDay)}if(existing>=0)nd.timeEntries[existing]=entry;else nd.timeEntries.push(entry);save(nd);setShowManual(false);setManStart('');setManEnd('');setManPause(0);setManBreakStart('12:00');setManBreakEnd('13:00');setManMeal('PANIER');setManAbsence('');setManNight(0);setManRequestEnd('')};
const hist30=useMemo(()=>{const now=new Date();const d30=new Date(now);d30.setDate(d30.getDate()-30);const start30=fmtDateISO(d30);const end30=fmtDateISO(now);return(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=start30&&t.date<=end30).sort((a,b)=>b.date.localeCompare(a.date))},[data.timeEntries,empId]);
const range=useMemo(()=>{const now=new Date();if(view==='Jour'){const d=new Date(now);d.setDate(d.getDate()+offset);return{start:fmtDateISO(d),end:fmtDateISO(d),label:fmtDate(d)}}const d=new Date(now);d.setDate(d.getDate()+offset*7);const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);const mon=new Date(d);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);return{start:fmtDateISO(mon),end:fmtDateISO(sun),label:fmtDate(mon)+' - '+fmtDate(sun)}},[view,offset]);
const periodTE=(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=range.start&&t.date<=range.end);
const periodJobs=(data.jobs||[]).filter(j=>j.employeeId===empId&&j.date>=range.start&&j.date<=range.end);
let totalWork=0,totalPause=0;periodTE.forEach(t=>{if(t.startTime&&t.endTime){totalWork+=calcWorkedMin(t);totalPause+=(t.pauseMin||0)}});
const weeklyTotal=useMemo(()=>{const now=new Date();const day=now.getDay();const diff=now.getDate()-day+(day===0?-6:1);const mon=new Date(now);mon.setDate(diff);const sun=new Date(mon);sun.setDate(mon.getDate()+6);const ws=fmtDateISO(mon);const we=fmtDateISO(sun);let wt=0;(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=ws&&t.date<=we).forEach(t=>{wt+=calcWorkedMin(t)});return wt},[data.timeEntries,empId]);
const monthlyTotal=useMemo(()=>{const now=new Date();const ms=now.getFullYear()+'-'+pad2(now.getMonth()+1)+'-01';const last=new Date(now.getFullYear(),now.getMonth()+1,0);const me=fmtDateISO(last);let mt=0;(data.timeEntries||[]).filter(t=>t.empId===empId&&t.date>=ms&&t.date<=me).forEach(t=>{mt+=calcWorkedMin(t)});return mt},[data.timeEntries,empId]);
const dates=[...new Set([...periodTE.map(t=>t.date),...periodJobs.map(j=>j.date)])].sort().reverse();
const saveEdit=()=>{if(!editTE)return;const nd=JSON.parse(JSON.stringify(data));const idx=nd.timeEntries.findIndex(t=>t.id===editTE.id);if(idx>=0)nd.timeEntries[idx]=editTE;save(nd);setEditTE(null)};
const delTE=(tid)=>{if(!confirm('Supprimer ?'))return;const nd=JSON.parse(JSON.stringify(data));nd.timeEntries=nd.timeEntries.filter(t=>t.id!==tid);save(nd)};
const[tab,setTab]=useState('heures');
const[selectedMachineId,setSelectedMachineId]=useState((emp&&emp.machineId)||'');
const[showEntFait,setShowEntFait]=useState(false);
const[entFaitDesc,setEntFaitDesc]=useState('');
const[showEntFaire,setShowEntFaire]=useState(false);
const[entFaireDesc,setEntFaireDesc]=useState('');
const[showEquip,setShowEquip]=useState(false);
// Signature chef de chantier
const[signJob,setSignJob]=useState(null);
const[signName,setSignName]=useState('');
const[signPhone,setSignPhone]=useState('');
const[signEmail,setSignEmail]=useState('');
const[signForfait,setSignForfait]=useState(null);
const signCanvas=useRef(null);const signCtx=useRef(null);const signDrawing=useRef(false);const signHasInk=useRef(false);
useEffect(()=>{if(!signJob||!signCanvas.current)return;const c=signCanvas.current;const dpr=window.devicePixelRatio||1;const rect=c.getBoundingClientRect();c.width=rect.width*dpr;c.height=rect.height*dpr;const ctx=c.getContext('2d');ctx.scale(dpr,dpr);ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#0f172a';ctx.lineWidth=2.5;signCtx.current=ctx;signHasInk.current=false},[signJob]);
const _signPos=e=>{const c=signCanvas.current;if(!c)return null;const r=c.getBoundingClientRect();const t=e.touches&&e.touches[0]?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top}};
const signStart=e=>{e.preventDefault();const p=_signPos(e);if(!p||!signCtx.current)return;signDrawing.current=true;signCtx.current.beginPath();signCtx.current.moveTo(p.x,p.y)};
const signMove=e=>{if(!signDrawing.current)return;e.preventDefault();const p=_signPos(e);if(!p||!signCtx.current)return;signCtx.current.lineTo(p.x,p.y);signCtx.current.stroke();signHasInk.current=true};
const signEnd=()=>{signDrawing.current=false};
const signClear=()=>{if(!signCanvas.current||!signCtx.current)return;const c=signCanvas.current;signCtx.current.clearRect(0,0,c.width,c.height);signHasInk.current=false};
const openSignModal=(j)=>{
  setSignJob(j);setSignName(j.siteManager||'');
  // Pre-remplit telephone / email depuis le siteManager du client si deja connu
  const _cl=(data.clients||[]).find(c=>c.id===j.clientId);
  const _sm=_cl&&_cl.siteManagers?(_cl.siteManagers.find(s=>s.name===j.siteManager&&(s.agency||'')===(j.agencyName||''))||_cl.siteManagers.find(s=>s.name===j.siteManager)):null;
  setSignPhone((_sm&&_sm.phone)||j.siteManagerPhone||'');
  setSignEmail((_sm&&_sm.email)||j.siteManagerEmail||'');
  // Calcul du forfait au moment de l'ouverture (visible avant signature)
  const _toM=t=>{if(!t)return null;const[h,m]=t.split(':').map(Number);return h*60+m};
  const billStart=_toM(j.billingStart);
  if(billStart==null){setSignForfait(null);return}
  const now=new Date();let endMin=now.getHours()*60+now.getMinutes();if(endMin<billStart)endMin+=1440;
  let dur=endMin-billStart;
  let pauseDeducted=0;
  const te=(data.timeEntries||[]).find(t=>t.empId===j.employeeId&&t.date===j.date&&(t.breakStart||t.pauseStart||t.pauseMin));
  if(te){const pS=_toM(te.breakStart||te.pauseStart);const pE=_toM(te.breakEnd||te.pauseEnd);const pM=(pS!=null&&pE!=null&&pE>pS)?(pE-pS):(te.pauseMin?Number(te.pauseMin):0);if(pS!=null&&pS>=billStart&&pM>0){dur-=pM;pauseDeducted=pM}}
  dur=Math.max(0,dur);const durH=dur/60;
  const m=(data.machines||[]).find(mm=>mm.id===j.machineId);
  let label=null;
  if(m&&m.type==='Citerne')label=durH<=4?'Demi-journee':'Journee';
  else{if(durH<=2)label='2h';else if(durH<=4)label='4h';else if(durH<=6)label='6h';else label='8h'}
  setSignForfait({label,durMin:dur,pauseDeducted,endHHmm:String(Math.floor((endMin%1440)/60)).padStart(2,'0')+':'+String(endMin%60).padStart(2,'0')});
};
const closeSignModal=()=>{setSignJob(null);setSignName('');setSignPhone('');setSignEmail('');setSignForfait(null)};
const signSave=()=>{if(!signJob)return;if(!signHasInk.current){alert('La signature est vide');return}if(!signName.trim()){alert('Nom du chef requis');return}const dataUrl=signCanvas.current.toDataURL('image/png');const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===signJob.id);if(!jj){closeSignModal();return}
// Applique le forfait pre-calcule (visible dans la modal)
if(signForfait&&signForfait.label){jj.forfaitType=signForfait.label;const m=(nd.machines||[]).find(mm=>mm.id===jj.machineId);const p=getForfaitPrice(nd,jj.clientId,m,signForfait.label,jj.citOption,jj.isNight);if(p)jj.priceForfait=p}
// Met a jour le chantier
jj.siteManager=signName.trim();
jj.siteManagerPhone=signPhone.trim();
jj.siteManagerEmail=signEmail.trim();
// Met a jour ou cree le siteManager dans le client (avec agence si renseignee)
if(jj.clientId){const _cl=nd.clients.find(c=>c.id===jj.clientId);if(_cl){if(!_cl.siteManagers)_cl.siteManagers=[];const _existing=_cl.siteManagers.find(s=>s.name===signName.trim()&&(s.agency||'')===(jj.agencyName||''));if(_existing){if(signPhone.trim())_existing.phone=signPhone.trim();if(signEmail.trim())_existing.email=signEmail.trim()}else{_cl.siteManagers.push({name:signName.trim(),phone:signPhone.trim(),email:signEmail.trim(),agency:jj.agencyName||''})}}}
jj.signature={dataUrl,signedBy:signName.trim(),signedAt:new Date().toISOString(),autoForfait:signForfait?signForfait.label:null,durationMin:signForfait?signForfait.durMin:null,pauseDeducted:signForfait?signForfait.pauseDeducted:0,phone:signPhone.trim(),email:signEmail.trim()};
save(nd);closeSignModal();alert('✓ Signature enregistree !')};
const selectedMachine=(data.machines||[]).find(m=>m.id===selectedMachineId)||null;
const submitEntFait=()=>{if(!selectedMachineId||!entFaitDesc.trim()){alert('Machine et description requises');return}const nd=JSON.parse(JSON.stringify(data));if(!nd.interventions)nd.interventions=[];nd.interventions.push({id:uid(),date:fmtDateISO(new Date()),machineId:selectedMachineId,type:'entretien',description:entFaitDesc,employeeId:empId,partsUsed:[],laborHours:0,laborCost:0,totalCost:0,status:'done',notes:'Declare par chauffeur'});save(nd);setShowEntFait(false);setEntFaitDesc('');alert('Entretien enregistre !')};
const submitEntFaire=()=>{if(!selectedMachineId||!entFaireDesc.trim()){alert('Machine et description requises');return}const nd=JSON.parse(JSON.stringify(data));if(!nd.maintenanceRequests)nd.maintenanceRequests=[];nd.maintenanceRequests.push({id:uid(),date:fmtDateISO(new Date()),reportedBy:empId,machineId:selectedMachineId,description:entFaireDesc,status:'new'});save(nd);setShowEntFaire(false);setEntFaireDesc('');alert('Demande envoyee !')};
const setEquipStatus=(eqId,status)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.machineEquipmentStatus)nd.machineEquipmentStatus={};if(!nd.machineEquipmentStatus[selectedMachineId])nd.machineEquipmentStatus[selectedMachineId]={};nd.machineEquipmentStatus[selectedMachineId][eqId]=status;save(nd)};
const openPanneForSelected=()=>{setPanneEquip(selectedMachineId||'');setPanneSev('normal');setPanneDesc('');setShowPanne(true)};
const openTakePartForSelected=()=>{const m=selectedMachine;setTakePartType(m?m.type:'');setTakePartEquip(selectedMachineId||'');setTakePartId('');setTakePartQte(1);setTakePartReason('');setShowTakePart(true)};
const notifyJobsRef=useRef(null);
const[toasts,setToasts]=useState([]);
const pushToast=(kind,text)=>{const id=uid();setToasts(ts=>[...ts,{id,kind,text}]);setTimeout(()=>setToasts(ts=>ts.filter(t=>t.id!==id)),10000)};
useEffect(()=>{if(typeof Notification!=='undefined'&&Notification.permission==='default'){try{Notification.requestPermission().catch(()=>{})}catch(e){}}},[]);
useEffect(()=>{
const myJobs=(data.jobs||[]).filter(j=>j.employeeId===empId);
if(notifyJobsRef.current===null){notifyJobsRef.current=myJobs;return}
const prev=notifyJobsRef.current;
notifyJobsRef.current=myJobs;
const strip=j=>{const{ack,ackDate,...r}=j||{};return JSON.stringify(r)};
const prevMap=new Map(prev.map(j=>[j.id,j]));
for(const job of myJobs){
const p=prevMap.get(job.id);
if(!p||strip(p)!==strip(job)){
const cl=(data.clients||[]).find(c=>c.id===job.clientId);
const mach=(data.machines||[]).find(m=>m.id===job.machineId);
const isNew=!p;
const title=isNew?'Nouveau chantier':'Chantier modifie';
const body=(cl?cl.name:'Chantier')+' — '+fmtDate(new Date(job.date))+(job.billingStart?' a '+job.billingStart:'')+(mach?' ('+mach.name+')':'');
pushToast(isNew?'new':'mod',title+' : '+body);
if(typeof Notification!=='undefined'&&Notification.permission==='granted'){try{const n=new Notification(title,{body,icon:'logo.png',tag:'job-'+job.id});n.onclick=()=>{window.focus();n.close()}}catch(e){}}
}
}
},[data.jobs,empId,data.clients,data.machines]);
if(!emp)return(<div style={{fontSize:14}}>Employe non trouve</div>);
// Styles modals salarie (plus gros, mobile-friendly)
const empInputS={fontSize:16,padding:'12px 14px',borderRadius:10,border:'2px solid #e2e8f0',background:'#fff',width:'100%',fontWeight:500,outline:'none',boxSizing:'border-box'};
const empLabelS={fontSize:11,fontWeight:700,color:C.dim,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:6,display:'block'};
const empBtnP=(bg)=>({padding:'14px 20px',fontSize:16,fontWeight:800,borderRadius:10,border:'none',cursor:'pointer',flex:1,color:'#fff',boxShadow:'0 2px 6px rgba(0,0,0,.12)',background:bg||C.accent});
const empBtnS={padding:'14px 20px',fontSize:15,fontWeight:600,borderRadius:10,border:'2px solid #cbd5e1',background:'#fff',color:'#475569',cursor:'pointer',flex:1};
const empTglBtn=(active,activeColor)=>({padding:'14px 16px',fontSize:15,fontWeight:700,borderRadius:10,border:'2px solid '+(active?activeColor:'#e2e8f0'),background:active?activeColor:'#fff',color:active?'#fff':C.dim,cursor:'pointer',flex:1,boxShadow:active?'0 2px 4px rgba(0,0,0,.1)':'none'});
return(
<div style={{maxWidth:700,margin:'0 auto',padding:16,fontSize:14}}>
<div style={{position:'fixed',top:12,left:'50%',transform:'translateX(-50%)',zIndex:9999,display:'flex',flexDirection:'column',gap:6,maxWidth:'92vw',width:'420px'}}>
{toasts.map(t=>(
<div key={t.id} onClick={()=>setToasts(ts=>ts.filter(x=>x.id!==t.id))} style={{background:t.kind==='new'?C.green:C.orange,color:'#fff',padding:'12px 16px',borderRadius:10,boxShadow:'0 6px 20px rgba(0,0,0,.25)',fontWeight:700,fontSize:14,cursor:'pointer'}}>
{t.kind==='new'?'🆕 ':'✏️ '}{t.text}
</div>
))}
</div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,background:C.accent,color:'#fff',padding:'12px 16px',borderRadius:10,boxShadow:'0 2px 6px rgba(0,0,0,.08)',gap:10}}>
<div style={{display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
<div style={{width:40,height:40,borderRadius:'50%',background:'#fff3',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:18}}>{(emp.name||'?')[0].toUpperCase()}</div>
<div><div style={{fontWeight:700,fontSize:18}}>{emp.name}</div><div style={{fontSize:14,opacity:.8}}>Espace chauffeur</div></div>
</div>
<img src="logo.png" alt="SONECO" style={{height:80,maxWidth:'40%',objectFit:'contain',flexShrink:1}}/>
<div style={{display:'flex',gap:6,flexShrink:0}}>
<button onClick={openInbox} title="Messages" style={{position:'relative',background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:16}}>🔔{unreadCount>0&&<span style={{position:'absolute',top:-4,right:-4,background:'#ef4444',color:'#fff',borderRadius:'50%',minWidth:18,height:18,fontSize:11,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',padding:'0 4px'}}>{unreadCount}</span>}</button>
<button onClick={()=>{loadData().then(d2=>{if(d2){save(d2);alert('Actualisé !')}})}} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>↻</button>
<button onClick={onLogout} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>Deconnexion</button>
</div>
</div>
{showInbox&&<Mod title={'Mes messages ('+myMsgs.length+')'} onClose={()=>setShowInbox(false)} width={500}>
{myMsgs.length===0?<div style={{textAlign:'center',color:C.muted,padding:'20px 0',fontSize:14}}>Aucun message</div>:myMsgs.map(m=>(
<div key={m.id} style={{background:'#f8fafc',border:'1px solid '+C.border,borderRadius:8,padding:'10px 12px',marginBottom:8}}>
<div style={{fontSize:11,color:C.muted,marginBottom:4}}>{m.date?new Date(m.date).toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short'}):''} · De l'administration</div>
<div style={{fontSize:14,color:C.text,whiteSpace:'pre-wrap',lineHeight:1.5}}>{m.content}</div>
</div>
))}
</Mod>}
<div style={{display:'flex',gap:4,marginBottom:16,background:'#f1f5f9',padding:4,borderRadius:12}}>
{[{k:'heures',l:'Heures',i:'⏱'},{k:'chantier',l:'Chantier',i:'🚧'},{k:'machine',l:'Machine',i:'⚙️'}].map(x=><button key={x.k} onClick={()=>setTab(x.k)} style={{flex:1,fontSize:14,padding:'12px 8px',border:'none',cursor:'pointer',borderRadius:8,background:tab===x.k?C.accent:'transparent',color:tab===x.k?'#fff':C.dim,fontWeight:tab===x.k?800:600,boxShadow:tab===x.k?'0 2px 6px rgba(0,0,0,.15)':'none',letterSpacing:'0.3px'}}>{x.i} {x.l}</button>)}
</div>
{showManual&&<Mod title="⏱ Saisir mes heures" onClose={()=>setShowManual(false)} width={460}>
<div style={{display:'flex',flexDirection:'column',gap:16}}>
  <div>
    <label style={empLabelS}>📅 Date</label>
    <input type="date" style={empInputS} value={manDate} onChange={e=>setManDate(e.target.value)}/>
  </div>
  <div>
    <label style={empLabelS}>⏰ Horaires</label>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
      <input type="time" style={empInputS} value={manStart} onChange={e=>setManStart(e.target.value)} placeholder="Embauche"/>
      <input type="time" style={empInputS} value={manEnd} onChange={e=>setManEnd(e.target.value)} placeholder="Debauche"/>
    </div>
    <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:10,color:C.dim,padding:'0 4px'}}>
      <span>Embauche</span><span>Debauche</span>
    </div>
  </div>
  <div>
    <label style={empLabelS}>☕ Pause repas</label>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
      <input type="time" style={empInputS} value={manBreakStart} onChange={e=>setManBreakStart(e.target.value)}/>
      <input type="time" style={empInputS} value={manBreakEnd} onChange={e=>setManBreakEnd(e.target.value)}/>
    </div>
    <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:10,color:C.dim,padding:'0 4px'}}>
      <span>Coupure</span><span>Reprise</span>
    </div>
  </div>
  <div>
    <label style={empLabelS}>🍽 Type de repas</label>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
      <button onClick={()=>setManMeal('PANIER')} style={empTglBtn(manMeal==='PANIER',C.accent)}>🥪 Panier</button>
      <button onClick={()=>setManMeal('RESTO')} style={empTglBtn(manMeal==='RESTO',C.orange)}>🍽 Restaurant</button>
    </div>
  </div>
  <details style={{borderTop:'1px dashed #cbd5e1',paddingTop:12}}>
    <summary style={{fontSize:13,fontWeight:600,color:C.dim,cursor:'pointer',userSelect:'none',marginBottom:10}}>⚙️ Options avancees</summary>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
      <div><label style={empLabelS}>Pause (min)</label><input type="number" style={empInputS} value={manPause} onChange={e=>setManPause(e.target.value)}/></div>
      <div><label style={empLabelS}>Heures nuit</label><input type="number" step="0.25" style={empInputS} value={manNight} onChange={e=>setManNight(e.target.value)}/></div>
    </div>
    <div>
      <label style={empLabelS}>🕒 Debauche demandee (RDV)</label>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <input type="time" style={{...empInputS,flex:1}} value={manRequestEnd} onChange={e=>setManRequestEnd(e.target.value)} placeholder="Ex: 16:00"/>
        {manRequestEnd&&<button onClick={()=>setManRequestEnd('')} style={{background:'#fef2f2',border:'2px solid #fca5a5',borderRadius:8,padding:'10px 14px',cursor:'pointer',color:C.red,fontSize:14,fontWeight:700}}>×</button>}
      </div>
      <div style={{fontSize:11,color:C.orange,marginTop:4}}>Indiquez ici si vous devez partir a une heure precise</div>
    </div>
  </details>
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={()=>setShowManual(false)} style={empBtnS}>Annuler</button>
    <button onClick={saveManual} style={empBtnP(C.accent)}>✓ Enregistrer</button>
  </div>
</div>
</Mod>}
{showRdv&&<Mod title="📅 Debauche / Absence" onClose={()=>setShowRdv(false)} width={440}>
<div style={{display:'flex',flexDirection:'column',gap:16}}>
  <div>
    <label style={empLabelS}>Type de demande</label>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
      <button onClick={()=>setRdvType('rdv')} style={empTglBtn(rdvType==='rdv',C.orange)}>🕐 Debauche RDV</button>
      <button onClick={()=>setRdvType('absence')} style={empTglBtn(rdvType==='absence',C.red)}>🚫 Absence</button>
    </div>
  </div>
  {rdvType==='rdv'&&<React.Fragment>
    <div>
      <label style={empLabelS}>📅 Date</label>
      <input type="date" style={empInputS} value={rdvDate} onChange={e=>setRdvDate(e.target.value)}/>
    </div>
    <div>
      <label style={empLabelS}>⏰ Heure de debauche souhaitee</label>
      <input type="time" style={empInputS} value={rdvTime} onChange={e=>setRdvTime(e.target.value)}/>
    </div>
    <div>
      <label style={empLabelS}>💬 Motif</label>
      <input style={empInputS} value={rdvMotif} onChange={e=>setRdvMotif(e.target.value)} placeholder="RDV medical, personnel..."/>
    </div>
  </React.Fragment>}
  {rdvType==='absence'&&<React.Fragment>
    <div>
      <label style={empLabelS}>📋 Motif d'absence</label>
      <select style={empInputS} value={rdvAbsType} onChange={e=>setRdvAbsType(e.target.value)}>
        <option value="conge">🏖 Conge</option>
        <option value="maladie">🤒 Maladie</option>
        <option value="rtt">⏸ RTT</option>
        <option value="formation">🎓 Formation</option>
        <option value="accident">🚑 Accident travail</option>
        <option value="autre">❓ Autre</option>
      </select>
    </div>
    <div>
      <label style={empLabelS}>📅 Periode</label>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <input type="date" style={empInputS} value={rdvDate} onChange={e=>setRdvDate(e.target.value)}/>
        <input type="date" style={empInputS} value={rdvDateFin} onChange={e=>setRdvDateFin(e.target.value)}/>
      </div>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:10,color:C.dim,padding:'0 4px'}}>
        <span>Du</span><span>Au</span>
      </div>
    </div>
    <div>
      <label style={empLabelS}>💬 Commentaire (optionnel)</label>
      <input style={empInputS} value={rdvMotif} onChange={e=>setRdvMotif(e.target.value)} placeholder="Precision..."/>
    </div>
  </React.Fragment>}
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={()=>setShowRdv(false)} style={empBtnS}>Annuler</button>
    <button onClick={submitRdv} style={empBtnP(rdvType==='rdv'?C.orange:C.red)}>✓ Envoyer</button>
  </div>
</div>
</Mod>}
{editTE&&<Mod title="✏️ Modifier pointage" onClose={()=>setEditTE(null)} width={440}>
<div style={{display:'flex',flexDirection:'column',gap:16}}>
  <div>
    <label style={empLabelS}>⏰ Horaires</label>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
      <input type="time" style={empInputS} value={editTE.startTime||''} onChange={e=>setEditTE({...editTE,startTime:e.target.value})}/>
      <input type="time" style={empInputS} value={editTE.endTime||''} onChange={e=>setEditTE({...editTE,endTime:e.target.value})}/>
    </div>
    <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:10,color:C.dim,padding:'0 4px'}}><span>Embauche</span><span>Debauche</span></div>
  </div>
  <div>
    <label style={empLabelS}>☕ Pause repas</label>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
      <input type="time" style={empInputS} value={editTE.breakStart||''} onChange={e=>{const v=e.target.value;setEditTE(prev=>{const n={...prev,breakStart:v};if(v&&n.breakEnd){const m=calcDiffMin(v,n.breakEnd);if(m>0)n.pauseMin=m}return n})}}/>
      <input type="time" style={empInputS} value={editTE.breakEnd||''} onChange={e=>{const v=e.target.value;setEditTE(prev=>{const n={...prev,breakEnd:v};if(n.breakStart&&v){const m=calcDiffMin(n.breakStart,v);if(m>0)n.pauseMin=m}return n})}}/>
    </div>
    <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:10,color:C.dim,padding:'0 4px'}}><span>Coupure</span><span>Reprise</span></div>
  </div>
  <div>
    <label style={empLabelS}>⏸ Pause totale (min)</label>
    <input type="number" style={empInputS} value={editTE.pauseMin||0} onChange={e=>setEditTE({...editTE,pauseMin:Number(e.target.value)})}/>
    <div style={{fontSize:11,color:C.dim,marginTop:4}}>Calculee auto si Coupure + Reprise renseignees</div>
  </div>
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={()=>setEditTE(null)} style={empBtnS}>Annuler</button>
    <button onClick={saveEdit} style={empBtnP(C.accent)}>✓ Enregistrer</button>
  </div>
</div>
</Mod>}
{showPanne&&<Mod title="⚠️ Signaler une panne" onClose={()=>setShowPanne(false)} width={440}>
<div style={{display:'flex',flexDirection:'column',gap:16}}>
  <div>
    <label style={empLabelS}>🔧 Equipement</label>
    <select style={empInputS} value={panneEquip} onChange={e=>setPanneEquip(e.target.value)}>
      <option value="">-- Choisir --</option>
      {allEquipEmp.map(eq=><option key={eq.id} value={eq.id}>({eq.t}) {eq.name}</option>)}
    </select>
  </div>
  <div>
    <label style={empLabelS}>🚨 Severite</label>
    <div style={{display:'grid',gridTemplateColumns:'repeat('+SEVERITIES.length+',1fr)',gap:8}}>
      {SEVERITIES.map(s=>{const col=s==='urgent'?C.red:s==='haute'?C.orange:s==='moyenne'?'#eab308':'#64748b';return<button key={s} onClick={()=>setPanneSev(s)} style={empTglBtn(panneSev===s,col)}>{s}</button>})}
    </div>
  </div>
  <div>
    <label style={empLabelS}>💬 Description</label>
    <textarea style={{...empInputS,height:100,fontFamily:'inherit',resize:'vertical'}} value={panneDesc} onChange={e=>setPanneDesc(e.target.value)} placeholder="Decrivez le probleme..."/>
  </div>
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={()=>setShowPanne(false)} style={empBtnS}>Annuler</button>
    <button onClick={submitPanne} style={empBtnP(C.red)}>✓ Envoyer</button>
  </div>
</div>
</Mod>}
{showTakePart&&<Mod title="🔩 Prendre une piece" onClose={()=>setShowTakePart(false)} width={460}>
<div style={{display:'flex',flexDirection:'column',gap:16}}>
  <div>
    <label style={empLabelS}>🚜 Type de machine</label>
    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
      {['Raboteuse','Balayeuse','Citerne'].map(t=><button key={t} onClick={()=>{setTakePartType(t);setTakePartEquip('');setTakePartId('')}} style={empTglBtn(takePartType===t,MC[t]||C.accent)}>{t}</button>)}
    </div>
  </div>
  {takePartType&&<div>
    <label style={empLabelS}>{takePartType} a affecter</label>
    <select style={empInputS} value={takePartEquip} onChange={e=>{setTakePartEquip(e.target.value);setTakePartId('')}}>
      <option value="">-- Choisir --</option>{(data.machines||[]).filter(mx=>mx.type===takePartType).map(mx=><option key={mx.id} value={mx.id}>{mx.name}</option>)}
    </select>
  </div>}
  {takePartEquip&&<div>
    <label style={empLabelS}>📦 Piece</label>
    <select style={empInputS} value={takePartId} onChange={e=>setTakePartId(e.target.value)}>
      <option value="">--</option>{availPartsForEmp.map(p=><option key={p.id} value={p.id}>{p.name} ({p.category}) — stock: {p.quantity}</option>)}
    </select>
  </div>}
  {takePartEquip&&<div style={{display:'grid',gridTemplateColumns:'1fr 2fr',gap:10}}>
    <div><label style={empLabelS}>🔢 Quantite</label><input type="number" style={empInputS} min="1" value={takePartQte} onChange={e=>setTakePartQte(Number(e.target.value)||1)}/></div>
    <div><label style={empLabelS}>💬 Raison</label><input style={empInputS} value={takePartReason} onChange={e=>setTakePartReason(e.target.value)} placeholder="Remplacement, reparation..."/></div>
  </div>}
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={()=>setShowTakePart(false)} style={empBtnS}>Annuler</button>
    <button onClick={submitTakePart} style={empBtnP(C.cyan)}>✓ Confirmer</button>
  </div>
</div>
</Mod>}
{showEntFait&&<Mod title={'🔧 Entretien fait'+(selectedMachine?' — '+selectedMachine.name:'')} onClose={()=>setShowEntFait(false)} width={440}>
<div style={{display:'flex',flexDirection:'column',gap:16}}>
  <div>
    <label style={empLabelS}>💬 Description de l'entretien</label>
    <textarea style={{...empInputS,height:110,fontFamily:'inherit',resize:'vertical'}} value={entFaitDesc} onChange={e=>setEntFaitDesc(e.target.value)} placeholder="Vidange, graissage, controle niveaux..."/>
  </div>
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={()=>setShowEntFait(false)} style={empBtnS}>Annuler</button>
    <button onClick={submitEntFait} style={empBtnP(C.green)}>✓ Enregistrer</button>
  </div>
</div>
</Mod>}
{showEntFaire&&<Mod title={'🛠 Entretien a faire'+(selectedMachine?' — '+selectedMachine.name:'')} onClose={()=>setShowEntFaire(false)} width={440}>
<div style={{display:'flex',flexDirection:'column',gap:16}}>
  <div>
    <label style={empLabelS}>💬 Decrire le besoin</label>
    <textarea style={{...empInputS,height:110,fontFamily:'inherit',resize:'vertical'}} value={entFaireDesc} onChange={e=>setEntFaireDesc(e.target.value)} placeholder="Ex: prevoir vidange, changement filtre..."/>
  </div>
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={()=>setShowEntFaire(false)} style={empBtnS}>Annuler</button>
    <button onClick={submitEntFaire} style={empBtnP(C.orange)}>✓ Envoyer</button>
  </div>
</div>
</Mod>}
{showEquip&&selectedMachine&&(()=>{const list=(data.equipmentLists||{})[selectedMachine.type]||[];const statMap=((data.machineEquipmentStatus||{})[selectedMachineId])||{};return(
<Mod title={'🧰 Equipements — '+selectedMachine.name+' ('+selectedMachine.type+')'} onClose={()=>setShowEquip(false)} width={520}>
<div style={{display:'flex',flexDirection:'column',gap:6}}>
  {list.length===0&&<div style={{fontSize:14,color:C.dim,padding:20,textAlign:'center',background:'#f8fafc',borderRadius:10,border:'1px dashed #cbd5e1'}}>Aucun equipement configure pour ce type.<br/>Demandez a l'admin.</div>}
  {list.map(eq=>{const st=statMap[eq.id]||'';return(
    <div key={eq.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,gap:8}}>
      <span style={{fontWeight:600,fontSize:15,flex:1}}>{eq.name}</span>
      <div style={{display:'flex',gap:6,flexShrink:0}}>
        <button onClick={()=>setEquipStatus(eq.id,'present')} style={{...empTglBtn(st==='present',C.green),padding:'8px 14px',fontSize:13,flex:'none'}}>✓ Present</button>
        <button onClick={()=>setEquipStatus(eq.id,'missing')} style={{...empTglBtn(st==='missing',C.red),padding:'8px 14px',fontSize:13,flex:'none'}}>× Manquant</button>
      </div>
    </div>)})}
  <button onClick={()=>setShowEquip(false)} style={{...empBtnP(C.accent),marginTop:12}}>Fermer</button>
</div>
</Mod>)})()}
{signJob&&<Mod title="✍️ Signature du chef de chantier" onClose={closeSignModal} width={520}>
<div style={{display:'flex',flexDirection:'column',gap:14}}>
  <div style={{background:'#f0fdf4',border:'2px solid #86efac',borderRadius:10,padding:'10px 14px',fontSize:13,color:'#15803d'}}>
    <div style={{fontWeight:700,marginBottom:4}}>📋 Chantier termine</div>
    <div style={{fontSize:12,color:'#166534'}}>{signJob.location||'Sans lieu'}{signJob.billingStart?' • Debut '+signJob.billingStart:''}{signForfait?' • Fin '+signForfait.endHHmm:''}</div>
  </div>
  {signForfait&&<div style={{background:'#eff6ff',border:'2px solid #93c5fd',borderRadius:10,padding:'12px 14px'}}>
    <div style={{fontSize:11,fontWeight:800,color:'#1d4ed8',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:6}}>💰 Forfait calcule automatiquement</div>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10,flexWrap:'wrap'}}>
      <div style={{fontSize:28,fontWeight:800,color:'#1d4ed8',lineHeight:1}}>{signForfait.label}</div>
      <div style={{fontSize:12,color:'#1e40af',textAlign:'right'}}>
        <div>Duree : <b>{Math.floor(signForfait.durMin/60)}h{String(signForfait.durMin%60).padStart(2,'0')}</b></div>
        {signForfait.pauseDeducted>0&&<div style={{color:'#d97706'}}>(pause {signForfait.pauseDeducted}min deduite)</div>}
      </div>
    </div>
  </div>}
  <div>
    <label style={empLabelS}>👤 Nom du chef de chantier</label>
    <input style={empInputS} value={signName} onChange={e=>setSignName(e.target.value)} placeholder="Nom et prenom"/>
  </div>
  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
    <div><label style={empLabelS}>📞 Telephone</label><input type="tel" style={empInputS} value={signPhone} onChange={e=>setSignPhone(e.target.value)} placeholder="06 12 34 56 78"/></div>
    <div><label style={empLabelS}>📧 Email facture</label><input type="email" style={empInputS} value={signEmail} onChange={e=>setSignEmail(e.target.value)} placeholder="contact@..."/></div>
  </div>
  <div>
    <label style={empLabelS}>✍️ Signature (utilisez le doigt ou la souris)</label>
    <canvas ref={signCanvas} style={{width:'100%',height:200,background:'#fff',border:'2px dashed #cbd5e1',borderRadius:10,touchAction:'none',cursor:'crosshair',display:'block'}} onMouseDown={signStart} onMouseMove={signMove} onMouseUp={signEnd} onMouseLeave={signEnd} onTouchStart={signStart} onTouchMove={signMove} onTouchEnd={signEnd}/>
    <button onClick={signClear} style={{marginTop:8,padding:'8px 14px',fontSize:13,fontWeight:600,borderRadius:8,border:'2px solid #cbd5e1',background:'#fff',color:'#475569',cursor:'pointer'}}>🗑 Effacer la signature</button>
  </div>
  <div style={{display:'flex',gap:10,marginTop:8}}>
    <button onClick={closeSignModal} style={empBtnS}>Annuler</button>
    <button onClick={signSave} style={empBtnP(C.accent)}>✓ Valider la signature</button>
  </div>
</div>
</Mod>}
{tab==='heures'&&<React.Fragment>
{(()=>{const statusLbl=status==='on'?'En activite':status==='pause'?'En pause':'Debauche';const statusCol=status==='on'?C.green:status==='pause'?C.orange:C.muted;const todayWorked=dayEntries.reduce((s,t)=>s+calcWorkedMin(t),0)+(status==='on'&&lastEntry&&lastEntry.startTime?Math.max(0,(new Date().getHours()*60+new Date().getMinutes())-(()=>{const[h,m]=lastEntry.startTime.split(':').map(Number);return h*60+m})()):0);return(
<div style={{background:C.card,borderRadius:14,padding:16,border:'1px solid '+C.border,marginBottom:16,boxShadow:'0 2px 8px rgba(0,0,0,.04)'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14,gap:10}}>
<div>
<div style={{fontSize:12,color:C.dim,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:2}}>{fmtDate(new Date())}</div>
<div style={{fontSize:30,fontWeight:800,color:C.text,lineHeight:1}}>{fmtDuration(todayWorked)}<span style={{fontSize:14,color:C.dim,fontWeight:500,marginLeft:6}}>aujourd'hui</span></div>
</div>
<div style={{background:statusCol,color:'#fff',padding:'5px 12px',borderRadius:20,fontSize:12,fontWeight:800,textTransform:'uppercase',letterSpacing:'0.5px',boxShadow:'0 2px 4px rgba(0,0,0,.15)'}}>● {statusLbl}</div>
</div>
<div style={{display:'grid',gridTemplateColumns:status==='on'?'1fr 1fr':'1fr',gap:8,marginBottom:12}}>
{status==='off'&&<button onClick={()=>doTime('start')} style={{...empBtnP(C.green),fontSize:17,padding:'16px 18px'}}>▶ Debut de journee</button>}
{status==='on'&&<button onClick={()=>doTime('pause_start')} style={{...empBtnP(C.orange),fontSize:16,padding:'14px 12px'}}>⏸ Pause</button>}
{status==='on'&&<button onClick={()=>doTime('done')} style={{...empBtnP(C.red),fontSize:16,padding:'14px 12px'}}>■ Fin de journee</button>}
{status==='pause'&&<button onClick={()=>doTime('resume')} style={{...empBtnP(C.green),fontSize:17,padding:'16px 18px'}}>▶ Reprise</button>}
</div>
{status!=='off'&&lastEntry&&<div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center',padding:'8px 12px',background:'#f8fafc',borderRadius:10,border:'1px solid '+C.border}}>
<span style={{fontSize:12,color:C.dim,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.3px'}}>🍽 Repas :</span>
<div style={{display:'flex',gap:6,flex:1}}>
{['PANIER','RESTO'].map(m=><button key={m} onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const e=nd.timeEntries.find(t=>t.id===lastEntry.id);if(e){e.mealType=m;save(nd)}}} style={{...empTglBtn(lastEntry.mealType===m,m==='PANIER'?C.accent:C.orange),padding:'6px 12px',fontSize:13,flex:1}}>{m}</button>)}
</div>
</div>}
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
<button onClick={()=>{setShowManual(true);setManDate(today);setManStart('');setManEnd('');setManPause(0)}} style={{padding:'12px 14px',borderRadius:10,border:'2px solid '+C.accent,background:C.accent+'10',color:C.accent,cursor:'pointer',fontSize:14,fontWeight:700}}>⏱ Saisir mes heures</button>
<button onClick={()=>{setShowRdv(true);setRdvType('rdv');const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);setRdvDate(fmtDateISO(tomorrow));setRdvDateFin('');setRdvTime('');setRdvMotif('');setRdvAbsType('conge')}} style={{padding:'12px 14px',borderRadius:10,border:'2px solid '+C.orange,background:C.orange+'10',color:C.orange,cursor:'pointer',fontSize:14,fontWeight:700}}>📅 RDV / Absence</button>
</div>
{isNightShift&&<div style={{background:'#fef3c7',border:'2px solid #f59e0b',borderRadius:10,padding:'10px 14px',marginBottom:10,fontSize:13,color:'#92400e',fontWeight:700}}>🌙 Shift de nuit en cours depuis {fmtDate(new Date(lastEntry.date))} — pensez a cliquer "Fin de journee" pour le terminer</div>}
<div style={{display:'flex',flexDirection:'column',gap:6}}>
{(isNightShift?[lastEntry,...dayEntries]:dayEntries).map(t=>{const wm=calcWorkedMin(t);const crossedMidnight=t.endDate&&t.endDate!==t.date;return(
<div key={t.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',background:'#f8fafc',borderRadius:10,border:'1px solid '+C.border,gap:8,flexWrap:'wrap'}}>
<div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
{t.date!==today&&<span style={{fontSize:11,color:C.dim,fontWeight:600,background:'#fff',padding:'2px 8px',borderRadius:6,border:'1px solid '+C.border}}>{fmtDate(new Date(t.date))}</span>}
<span style={{fontWeight:800,fontSize:16,color:C.text}}>{t.startTime||'--:--'} → {t.endTime||'...'}</span>
{crossedMidnight&&<span style={{fontSize:10,color:'#fff',background:C.purple,padding:'2px 6px',borderRadius:6,fontWeight:700}}>🌙 lendemain</span>}
{t.pauseMin>0&&<span style={{fontSize:11,color:C.orange,background:C.orange+'18',padding:'2px 8px',borderRadius:6,fontWeight:700}}>⏸ {t.pauseMin}min</span>}
{wm>0&&<span style={{fontSize:13,color:'#fff',background:C.accent,padding:'2px 10px',borderRadius:6,fontWeight:800}}>{fmtDuration(wm)}</span>}
</div>
<div style={{display:'flex',gap:6}}>
<button onClick={()=>setEditTE({...t})} style={{background:'#fff',border:'1px solid '+C.accent,color:C.accent,borderRadius:8,padding:'6px 10px',cursor:'pointer',fontSize:12,fontWeight:700}}>✎</button>
<button onClick={()=>delTE(t.id)} style={{background:'#fff',border:'1px solid '+C.red,color:C.red,borderRadius:8,padding:'6px 10px',cursor:'pointer',fontSize:12,fontWeight:700}}>🗑</button>
</div>
</div>)})}
</div>
</div>);})()}
<div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12,flexWrap:'wrap',background:'#f1f5f9',padding:6,borderRadius:10}}>
{['Jour','Semaine'].map(v=><button key={v} onClick={()=>{setView(v);setOffset(0)}} style={{padding:'8px 14px',borderRadius:8,border:'none',background:view===v?C.accent:'transparent',color:view===v?'#fff':C.dim,fontWeight:view===v?800:600,fontSize:13,cursor:'pointer',boxShadow:view===v?'0 1px 3px rgba(0,0,0,.12)':'none'}}>{v}</button>)}
<button onClick={()=>setOffset(o=>o-1)} style={{padding:'6px 12px',borderRadius:8,border:'none',background:'transparent',color:C.dim,fontWeight:700,fontSize:14,cursor:'pointer'}}>‹</button>
<span style={{fontWeight:700,fontSize:14,flex:1,textAlign:'center',color:C.text}}>{range.label}</span>
<button onClick={()=>setOffset(o=>o+1)} style={{padding:'6px 12px',borderRadius:8,border:'none',background:'transparent',color:C.dim,fontWeight:700,fontSize:14,cursor:'pointer'}}>›</button>
</div>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}}>
<div style={{background:'#fff',borderRadius:12,padding:'14px 12px',border:'2px solid '+C.accent+'30',textAlign:'center',boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}><div style={{fontSize:11,color:C.dim,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:4}}>⏱ Travail</div><div style={{fontSize:22,fontWeight:800,color:C.accent,lineHeight:1}}>{fmtDuration(totalWork)}</div></div>
<div style={{background:'#fff',borderRadius:12,padding:'14px 12px',border:'2px solid '+C.orange+'30',textAlign:'center',boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}><div style={{fontSize:11,color:C.dim,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:4}}>⏸ Pause</div><div style={{fontSize:22,fontWeight:800,color:C.orange,lineHeight:1}}>{fmtDuration(totalPause)}</div></div>
</div>
{dates.filter(d=>periodTE.some(t=>t.date===d)).map(date=>{const tes=periodTE.filter(t=>t.date===date);return(
<div key={date} style={{background:C.card,borderRadius:12,padding:0,marginBottom:10,border:'1px solid '+C.border,overflow:'hidden',boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}>
<div style={{fontWeight:800,fontSize:14,padding:'8px 14px',background:C.accent+'10',color:C.accent,borderBottom:'1px solid '+C.accent+'20',textTransform:'uppercase',letterSpacing:'0.5px'}}>{fmtDate(new Date(date))}</div>
<div style={{padding:'8px 12px',display:'flex',flexDirection:'column',gap:6}}>
{tes.map(t=>{const wm=calcWorkedMin(t);const crossed=t.endDate&&t.endDate!==t.date;return(
<div key={t.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:14,padding:'8px 10px',background:'#f8fafc',borderRadius:8,gap:8,flexWrap:'wrap'}}>
<div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
<span style={{fontWeight:800,fontSize:15,color:C.text}}>{t.startTime} → {t.endTime||'...'}</span>
{crossed&&<span style={{fontSize:10,color:'#fff',background:C.purple,padding:'2px 6px',borderRadius:6,fontWeight:700}}>🌙 lendemain</span>}
{t.pauseMin>0&&<span style={{fontSize:11,color:C.orange,background:C.orange+'18',padding:'2px 8px',borderRadius:6,fontWeight:700}}>⏸ {t.pauseMin}min</span>}
{wm>0&&<span style={{fontSize:13,color:'#fff',background:C.accent,padding:'2px 10px',borderRadius:6,fontWeight:800}}>{fmtDuration(wm)}</span>}
</div>
<div style={{display:'flex',gap:6}}>
<button onClick={()=>setEditTE({...t})} style={{background:'#fff',border:'1px solid '+C.accent,color:C.accent,borderRadius:8,padding:'5px 10px',cursor:'pointer',fontSize:12,fontWeight:700}}>✎</button>
<button onClick={()=>delTE(t.id)} style={{background:'#fff',border:'1px solid '+C.red,color:C.red,borderRadius:8,padding:'5px 10px',cursor:'pointer',fontSize:12,fontWeight:700}}>🗑</button>
</div>
</div>)})}
</div>
</div>)})}
<div style={{background:C.card,borderRadius:14,padding:0,border:'1px solid '+C.border,marginTop:16,overflow:'hidden',boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}>
<div style={{padding:'12px 16px',background:'#f8fafc',borderBottom:'1px solid '+C.border,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
<h3 style={{margin:0,fontSize:16,fontWeight:800}}>📅 Historique 30 jours</h3>
<div style={{display:'flex',gap:10,fontSize:11,color:C.dim}}>
<span>Semaine <b style={{color:C.accent,fontSize:13}}>{fmtDuration(weeklyTotal)}</b></span>
<span>Mois <b style={{color:C.green,fontSize:13}}>{fmtDuration(monthlyTotal)}</b></span>
</div>
</div>
<div style={{padding:'8px 12px',display:'flex',flexDirection:'column',gap:6}}>
{hist30.length===0&&<div style={{fontSize:14,color:C.dim,textAlign:'center',padding:16}}>Aucun pointage</div>}
{hist30.map(t=>{const wm2=calcWorkedMin(t);const crossed2=t.endDate&&t.endDate!==t.date;return(
<div key={t.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 10px',background:'#f8fafc',borderRadius:8,gap:8,flexWrap:'wrap'}}>
<div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
<span style={{fontWeight:600,fontSize:12,color:C.dim,background:'#fff',padding:'3px 8px',borderRadius:6,border:'1px solid '+C.border}}>{fmtDate(new Date(t.date))}</span>
<span style={{fontWeight:800,fontSize:15,color:C.text}}>{t.startTime||'--'} → {t.endTime||'--'}</span>
{crossed2&&<span style={{fontSize:10,color:'#fff',background:C.purple,padding:'2px 6px',borderRadius:6,fontWeight:700}}>🌙</span>}
{t.pauseMin>0&&<span style={{fontSize:11,color:C.orange,background:C.orange+'18',padding:'2px 8px',borderRadius:6,fontWeight:700}}>⏸ {t.pauseMin}min</span>}
{wm2>0&&<span style={{fontSize:13,color:'#fff',background:C.accent,padding:'2px 10px',borderRadius:6,fontWeight:800}}>{fmtDuration(wm2)}</span>}
</div>
<div style={{display:'flex',gap:6}}>
<button onClick={()=>setEditTE({...t})} style={{background:'#fff',border:'1px solid '+C.accent,color:C.accent,borderRadius:8,padding:'5px 10px',cursor:'pointer',fontSize:12,fontWeight:700}}>✎</button>
<button onClick={()=>delTE(t.id)} style={{background:'#fff',border:'1px solid '+C.red,color:C.red,borderRadius:8,padding:'5px 10px',cursor:'pointer',fontSize:12,fontWeight:700}}>🗑</button>
</div>
</div>)})}
</div>
</div>
</React.Fragment>}
{tab==='chantier'&&<React.Fragment>
<div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12,flexWrap:'wrap',background:'#f1f5f9',padding:6,borderRadius:10}}>
{['Jour','Semaine'].map(v=><button key={v} onClick={()=>{setView(v);setOffset(0)}} style={{padding:'8px 14px',borderRadius:8,border:'none',background:view===v?C.accent:'transparent',color:view===v?'#fff':C.dim,fontWeight:view===v?800:600,fontSize:13,cursor:'pointer',boxShadow:view===v?'0 1px 3px rgba(0,0,0,.12)':'none'}}>{v}</button>)}
<button onClick={()=>setOffset(o=>o-1)} style={{padding:'6px 12px',borderRadius:8,border:'none',background:'transparent',color:C.dim,fontWeight:700,fontSize:14,cursor:'pointer'}}>‹</button>
<span style={{fontWeight:700,fontSize:14,flex:1,textAlign:'center',color:C.text}}>{range.label}</span>
<button onClick={()=>setOffset(o=>o+1)} style={{padding:'6px 12px',borderRadius:8,border:'none',background:'transparent',color:C.dim,fontWeight:700,fontSize:14,cursor:'pointer'}}>›</button>
</div>
<div style={{background:'#fff',borderRadius:12,padding:'14px 12px',border:'2px solid '+C.accent+'30',textAlign:'center',marginBottom:16,boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}><div style={{fontSize:11,color:C.dim,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:4}}>🚧 Missions sur la periode</div><div style={{fontSize:30,fontWeight:800,color:C.accent,lineHeight:1}}>{periodJobs.length}</div></div>
{dates.filter(d=>periodJobs.some(j=>j.date===d)).length===0&&<div style={{fontSize:14,color:C.dim,textAlign:'center',padding:32,background:'#f8fafc',borderRadius:12,border:'1px dashed #cbd5e1'}}>Aucun chantier sur la periode.</div>}
{dates.filter(d=>periodJobs.some(j=>j.date===d)).map(date=>{const jbs=periodJobs.filter(j=>j.date===date);return(
<div key={date} style={{background:C.card,borderRadius:12,padding:0,marginBottom:10,border:'1px solid '+C.border,overflow:'hidden',boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}>
<div style={{fontWeight:800,fontSize:14,padding:'8px 14px',background:C.accent+'10',color:C.accent,borderBottom:'1px solid '+C.accent+'20',textTransform:'uppercase',letterSpacing:'0.5px'}}>{fmtDate(new Date(date))}</div>
<div style={{padding:'8px 10px',display:'flex',flexDirection:'column',gap:6}}>
{jbs.map(j=>{const cl=(data.clients||[]).find(c=>c.id===j.clientId);const m=(data.machines||[]).find(x=>x.id===j.machineId);const depN=j.startFrom==='home'?'Domicile':((data.depots||[]).find(d=>d.id===j.startFrom)||{}).name||'';const arrN=j.endAt==='home'?'Domicile':((data.depots||[]).find(d=>d.id===j.endAt)||{}).name||'';const isDepot=j.type==='depot';const depotObj=isDepot?(data.depots||[]).find(d=>d.id===j.depotId):null;return(
<div key={j.id} style={{background:j.ack?'#dcfce7':isDepot?'#f8fafc':C.card,borderRadius:8,padding:10,marginTop:4,fontSize:14,borderLeft:'3px solid '+(isDepot?'#64748b':m?MC[m.type]||C.accent:C.muted)}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
<div style={{fontWeight:700,fontSize:16}}>{isDepot?<span style={{color:'#64748b'}}>{depotObj?depotObj.name:'Depot'} — {j.depotActivity||'Depot'}{j.depotDescription?' ('+j.depotDescription+')':''}</span>:(cl?cl.name:'Pas de client')}{!isDepot&&j.agencyName?' - '+j.agencyName:''}</div>
<div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
{!j.ack?<button onClick={()=>{const nd=JSON.parse(JSON.stringify(data));const jj=nd.jobs.find(x=>x.id===j.id);if(jj){jj.ack=true;save(nd)}}} style={{padding:'6px 14px',borderRadius:6,fontSize:14,fontWeight:700,background:C.green,color:'#fff',border:'none',cursor:'pointer'}}>✓ Lu</button>:<span style={{padding:'4px 10px',borderRadius:6,fontSize:13,fontWeight:700,background:'#16a34a20',color:C.green}}>✓ Pris en compte</span>}
{!isDepot&&(j.signature?<span title={'Signe par '+j.signature.signedBy+' le '+new Date(j.signature.signedAt).toLocaleString('fr-FR')} style={{padding:'4px 10px',borderRadius:6,fontSize:13,fontWeight:700,background:C.accent+'20',color:C.accent,cursor:'help'}}>✓ Signe</span>:<button onClick={()=>openSignModal(j)} style={{padding:'6px 12px',borderRadius:6,fontSize:13,fontWeight:700,background:'#fff',border:'2px solid '+C.accent,color:C.accent,cursor:'pointer'}}>✍️ Faire signer le chef</button>)}
</div>
</div>
<div style={{fontSize:14,marginTop:2}}>{m&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:(MC[m.type]||C.accent)+'18',color:MC[m.type]||C.accent}}>{m.name} ({m.type})</span>} <span style={{color:C.orange,fontWeight:600,marginLeft:4}}>{j.billingStart}</span> <span style={{color:C.dim}}>{j.forfaitType}</span></div>
{j.siteManager&&<div style={{color:C.dim,fontSize:14,marginTop:2}}>{j.siteManager} {j.siteManagerPhone&&<a href={'tel:'+j.siteManagerPhone} style={{color:C.accent}}>{j.siteManagerPhone}</a>}</div>}
{j.location&&<div style={{fontSize:14,marginTop:2}}>{j.gps?<a href={'https://www.google.com/maps?q='+j.gps} target="_blank" rel="noopener" style={{color:C.accent}}>{j.location}</a>:<span style={{color:C.dim}}>{j.location}</span>}</div>}
{(depN||arrN)&&<div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:4}}>
{depN&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:'#0891b215',color:'#0891b2'}}>{'↗'} {depN}{j.kmAller>0?' '+j.kmAller.toFixed(0)+'km':''}</span>}
{arrN&&<span style={{padding:'2px 8px',borderRadius:10,fontSize:12,fontWeight:600,background:'#7c3aed15',color:'#7c3aed'}}>{'↙'} {arrN}{j.kmRetour>0?' '+j.kmRetour.toFixed(0)+'km':''}</span>}
</div>}
{(()=>{const cols=(data.jobs||[]).filter(jj=>jj.id!==j.id&&jj.date===j.date&&jj.employeeId&&jj.employeeId!==empId&&j.location&&jj.location&&jj.location.trim().toLowerCase()===j.location.trim().toLowerCase());if(!cols.length)return null;return(<div style={{marginTop:6,padding:'6px 8px',background:'#f0f9ff',borderRadius:8,border:'1px solid #bae6fd'}}><div style={{fontSize:12,color:'#0369a1',fontWeight:700,marginBottom:4}}>{'👷 Equipe sur ce chantier :'}</div><div style={{display:'flex',gap:4,flexWrap:'wrap'}}>{cols.map(jj=>{const ce=(data.employees||[]).find(e=>e.id===jj.employeeId);return ce?<span key={jj.id} style={{background:'#0891b2',borderRadius:6,padding:'3px 10px',fontSize:13,fontWeight:700,color:'#fff'}}>{ce.name}</span>:null})}</div></div>);})()}
</div>)})}
</div>
</div>)})}
</React.Fragment>}
{tab==='machine'&&<React.Fragment>
<div style={{background:C.card,borderRadius:14,padding:16,border:'1px solid '+C.border,marginBottom:16,boxShadow:'0 1px 3px rgba(0,0,0,.04)'}}>
<label style={empLabelS}>⚙️ Machine selectionnee</label>
<select style={empInputS} value={selectedMachineId} onChange={e=>setSelectedMachineId(e.target.value)}>
<option value="">-- Choisir une machine --</option>
{(data.machines||[]).map(m=><option key={m.id} value={m.id}>{m.name} ({m.type})</option>)}
</select>
{selectedMachine?<div style={{background:(MC[selectedMachine.type]||C.accent)+'10',border:'2px solid '+(MC[selectedMachine.type]||C.accent)+'40',borderRadius:10,padding:12,marginTop:12,fontSize:14}}>
<div style={{fontWeight:800,fontSize:20,color:MC[selectedMachine.type]||C.accent,lineHeight:1}}>{selectedMachine.name}</div>
<div style={{fontSize:12,color:C.dim,fontWeight:600,marginTop:3,textTransform:'uppercase',letterSpacing:'0.3px'}}>{selectedMachine.type}{selectedMachine.width?' • '+selectedMachine.width+'m':''}</div>
{(()=>{const stat=((data.machineEquipmentStatus||{})[selectedMachine.id])||{};const missing=Object.entries(stat).filter(([_,v])=>v==='missing').length;return missing>0?<div style={{marginTop:8,fontSize:13,fontWeight:700,color:C.red,background:'#fef2f2',padding:'6px 10px',borderRadius:8,border:'1px solid '+C.red+'40'}}>⚠ {missing} equipement(s) manquant(s)</div>:null})()}
</div>:<div style={{fontSize:13,color:C.dim,padding:16,textAlign:'center',background:'#f8fafc',borderRadius:10,marginTop:12,border:'1px dashed #cbd5e1'}}>Aucune machine selectionnee</div>}
</div>
{selectedMachineId&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:16}}>
<button onClick={()=>{setEntFaitDesc('');setShowEntFait(true)}} style={{...empBtnP(C.green),padding:'18px 12px'}}>✓ Entretien fait</button>
<button onClick={()=>{setEntFaireDesc('');setShowEntFaire(true)}} style={{...empBtnP(C.orange),padding:'18px 12px'}}>🔧 Entretien a faire</button>
<button onClick={openPanneForSelected} style={{...empBtnP(C.red),padding:'18px 12px'}}>⚠ Signaler panne</button>
<button onClick={()=>setShowEquip(true)} style={{...empBtnP(C.accent),padding:'18px 12px'}}>📋 Equipement</button>
<button onClick={openTakePartForSelected} style={{...empBtnP(C.cyan),padding:'18px 12px',gridColumn:'1 / span 2'}}>🔩 Prendre une piece</button>
</div>}
</React.Fragment>}
</div>)};

// ======== STOCK PIECES ========
const StockPage=({data,save,isAdmin})=>{
const[selDepot,setSelDepot]=useState((data.depots||[])[0]?.id||'');
const[search,setSearch]=useState('');
const[catFilter,setCatFilter]=useState('');
const[showAdd,setShowAdd]=useState(false);
const[sel,setSel]=useState(null);
const blank={name:'',reference:'',category:'pneu',compatibleWith:[],depotId:selDepot,quantity:0,unitPrice:0,minStock:1,supplier:'',history:[]};
const parts=(data.parts||[]).filter(p=>(!selDepot||p.depotId===selDepot)&&(!catFilter||p.category===catFilter)&&(!search||p.name.toLowerCase().includes(search.toLowerCase())||p.reference.toLowerCase().includes(search.toLowerCase())));
const totalVal=parts.reduce((s,p)=>s+(p.quantity||0)*(p.unitPrice||0),0);
const openEdit=p=>{setSel({...p,compatibleWith:[...(p.compatibleWith||[])]});setShowAdd(true)};
const doSave=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.parts)nd.parts=[];const idx=nd.parts.findIndex(p=>p.id===sel.id);if(idx>=0)nd.parts[idx]=sel;else{sel.id=uid();nd.parts.push(sel)}save(nd);setShowAdd(false);setSel(null)};
const doDelete=id=>{if(!confirm('Supprimer ?'))return;save({...data,parts:(data.parts||[]).filter(p=>p.id!==id)})};
const doStockIn=(p)=>{const qte=prompt('Quantite a ajouter ?');if(!qte)return;const n=Number(qte);if(!n||n<=0)return;const nd=JSON.parse(JSON.stringify(data));const pp=nd.parts.find(x=>x.id===p.id);if(pp){pp.quantity=(pp.quantity||0)+n;if(!pp.history)pp.history=[];pp.history.unshift({type:'in',quantity:n,date:fmtDateISO(new Date()),unitPrice:pp.unitPrice});pp.history=pp.history.slice(0,50);save(nd)}};
const doStockOut=(p)=>{const qte=prompt('Quantite a retirer ?');if(!qte)return;const n=Number(qte);if(!n||n<=0)return;if(n>p.quantity){alert('Stock insuffisant');return}const nd=JSON.parse(JSON.stringify(data));const pp=nd.parts.find(x=>x.id===p.id);if(pp){pp.quantity=Math.max(0,pp.quantity-n);if(!pp.history)pp.history=[];pp.history.unshift({type:'out',quantity:n,date:fmtDateISO(new Date())});pp.history=pp.history.slice(0,50);save(nd)}};
const allEquip=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'M'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'C'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'V'}))];
const equipName=id=>{const e=allEquip.find(x=>x.id===id);return e?e.name:'?'};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
<h2 style={{margin:0}}>Stock pieces</h2>
<div style={{display:'flex',gap:6,alignItems:'center'}}>
{isAdmin&&<span style={{fontSize:13,color:C.dim}}>Valeur: <b style={{color:C.accent}}>{fmtMoney(totalVal)}</b></span>}
<button style={btnStyle(C.accent,true)} onClick={()=>{setSel({...blank,depotId:selDepot});setShowAdd(true)}}>+ Ajouter</button>
</div></div>
<div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap',alignItems:'center'}}>
<select style={{...inputStyle,width:160}} value={selDepot} onChange={e=>setSelDepot(e.target.value)}><option value="">Tous depots</option>{(data.depots||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>
<input style={{...inputStyle,width:200}} placeholder="Rechercher..." value={search} onChange={e=>setSearch(e.target.value)}/>
<select style={{...inputStyle,width:140}} value={catFilter} onChange={e=>setCatFilter(e.target.value)}><option value="">Toutes</option>{PART_CATS.map(c=><option key={c} value={c}>{c}</option>)}</select>
</div>
<div className="grid-cards" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:12}}>
{parts.map(p=>(
<div key={p.id} style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,borderLeft:'3px solid '+(p.quantity<=(p.minStock||0)?C.red:C.green)}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
<strong style={{fontSize:14}}>{p.name}</strong>
<div style={{display:'flex',gap:4}}><EBtn onClick={()=>openEdit(p)}/>{isAdmin&&<button onClick={()=>doDelete(p.id)} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:14}}>x</button>}</div>
</div>
<div style={{fontSize:12,color:C.dim}}>Ref: {p.reference||'-'} | {p.supplier||'-'} | {p.category}</div>
<div style={{fontSize:13,marginTop:4}}>
<span style={{fontWeight:700,color:p.quantity<=(p.minStock||0)?C.red:C.green}}>Stock: {p.quantity}</span>
<span style={{color:C.dim}}> | {fmtMoney(p.unitPrice)}/u | Val: {fmtMoney(p.quantity*p.unitPrice)}</span>
{p.quantity<=(p.minStock||0)&&<span style={{color:C.red,fontWeight:700,marginLeft:4}}>(min: {p.minStock})</span>}
</div>
{(p.compatibleWith||[]).length>0&&<div style={{fontSize:11,color:C.dim,marginTop:2}}>Compatible: {p.compatibleWith.map(equipName).join(', ')}</div>}
<div style={{display:'flex',gap:4,marginTop:6}}>
<button onClick={()=>doStockIn(p)} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>+Entree</button>
<button onClick={()=>doStockOut(p)} style={{...btnStyle(C.red),padding:'2px 8px',fontSize:11}}>-Sortie</button>
</div>
{(p.history||[]).length>0&&<div style={{marginTop:6,maxHeight:80,overflow:'auto',fontSize:11}}>
{(p.history||[]).slice(0,5).map((h,i)=><div key={i} style={{color:h.type==='in'?C.green:C.red,padding:'1px 0'}}>{h.type==='in'?'+':'-'}{h.quantity} | {h.date}{h.usedBy?' | '+h.usedBy:''}</div>)}
</div>}
</div>))}
</div>
{showAdd&&sel&&<Mod title={sel.id?'Modifier piece':'Nouvelle piece'} onClose={()=>{setShowAdd(false);setSel(null)}} width={500}>
<Fl label="Nom"><input style={inputStyle} value={sel.name} onChange={e=>setSel({...sel,name:e.target.value})}/></Fl>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Reference"><input style={inputStyle} value={sel.reference||''} onChange={e=>setSel({...sel,reference:e.target.value})}/></Fl>
<Fl label="Categorie"><select style={inputStyle} value={sel.category} onChange={e=>setSel({...sel,category:e.target.value})}>{PART_CATS.map(c=><option key={c} value={c}>{c}</option>)}</select></Fl>
</div>
<Fl label="Depot"><select style={inputStyle} value={sel.depotId||''} onChange={e=>setSel({...sel,depotId:e.target.value})}><option value="">--</option>{(data.depots||[]).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Fl>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
<Fl label="Quantite"><input type="number" style={inputStyle} value={sel.quantity} onChange={e=>setSel({...sel,quantity:Number(e.target.value)})}/></Fl>
<Fl label="Prix unitaire"><input type="number" step="0.01" style={inputStyle} value={sel.unitPrice} onChange={e=>setSel({...sel,unitPrice:Number(e.target.value)})}/></Fl>
<Fl label="Stock min"><input type="number" style={inputStyle} value={sel.minStock||1} onChange={e=>setSel({...sel,minStock:Number(e.target.value)})}/></Fl>
</div>
<Fl label="Fournisseur"><input style={inputStyle} value={sel.supplier||''} onChange={e=>setSel({...sel,supplier:e.target.value})}/></Fl>
<Fl label="Compatible avec"><div style={{display:'flex',gap:4,flexWrap:'wrap'}}>{allEquip.map(eq=>{const checked=(sel.compatibleWith||[]).includes(eq.id);return(<label key={eq.id} style={{fontSize:12,display:'flex',gap:3,alignItems:'center',cursor:'pointer'}}><input type="checkbox" checked={checked} onChange={()=>{const cw=[...(sel.compatibleWith||[])];if(checked)setSel({...sel,compatibleWith:cw.filter(x=>x!==eq.id)});else setSel({...sel,compatibleWith:[...cw,eq.id]})}}/>({eq.t}) {eq.name}</label>)})}</div></Fl>
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={doSave} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>{setShowAdd(false);setSel(null)}} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
</div>)};

// ======== INTERVENTIONS ========
const InterventionsPage=({data,save,isAdmin})=>{
const[showAdd,setShowAdd]=useState(false);
const[sel,setSel]=useState(null);
const[filter,setFilter]=useState('');
const[panneTab,setPanneTab]=useState('interventions');
const[showPartPicker,setShowPartPicker]=useState(false);
const[pickerPartId,setPickerPartId]=useState('');
const[pickerQte,setPickerQte]=useState(1);
const allEquip=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'machine'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'camion'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'voiture'}))];
const equipName=id=>{const e=allEquip.find(x=>x.id===id);return e?e.name:'?'};
const interventions=(data.interventions||[]).filter(i=>!filter||(i.machineId===filter||i.truckId===filter||i.carId===filter)).sort((a,b)=>b.date.localeCompare(a.date));
const pannes=(data.panneReports||[]).sort((a,b)=>b.date.localeCompare(a.date));
const blankInter={date:fmtDateISO(new Date()),machineId:'',truckId:'',carId:'',type:'entretien',description:'',employeeId:'',partsUsed:[],laborHours:0,laborCost:0,totalCost:0,status:'done',notes:''};
const openAdd=()=>{setSel({...blankInter});setShowAdd(true)};
const openEdit=i=>{setSel({...i,partsUsed:[...(i.partsUsed||[])]});setShowAdd(true)};
const doSave=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.interventions)nd.interventions=[];const partsCost=(sel.partsUsed||[]).reduce((s,p)=>s+(p.totalPrice||0),0);sel.totalCost=partsCost+(Number(sel.laborCost)||0);const idx=nd.interventions.findIndex(i=>i.id===sel.id);if(idx>=0)nd.interventions[idx]=sel;else{sel.id=uid();nd.interventions.push(sel)}sel.partsUsed.forEach(pu=>{const pp=nd.parts.find(x=>x.id===pu.partId);if(pp){pp.quantity=Math.max(0,(pp.quantity||0)-pu.quantity);if(!pp.history)pp.history=[];pp.history.unshift({type:'out',quantity:pu.quantity,date:sel.date,reason:sel.description});pp.history=pp.history.slice(0,50)}});save(nd);setShowAdd(false);setSel(null)};
const delInter=id=>{if(!confirm('Supprimer ?'))return;save({...data,interventions:(data.interventions||[]).filter(i=>i.id!==id)})};
const updatePanneStatus=(pid,status)=>{const nd=JSON.parse(JSON.stringify(data));const p=(nd.panneReports||[]).find(x=>x.id===pid);if(p){p.status=status;if(status==='resolved')p.resolvedDate=fmtDateISO(new Date());save(nd)}};
const maintReqs=(data.maintenanceRequests||[]).sort((a,b)=>b.date.localeCompare(a.date));
const updateMaintStatus=(mid,status)=>{const nd=JSON.parse(JSON.stringify(data));const m=(nd.maintenanceRequests||[]).find(x=>x.id===mid);if(m){m.status=status;if(status==='done')m.doneDate=fmtDateISO(new Date());save(nd)}};
const delMaintReq=(mid)=>{if(!confirm('Supprimer cette demande ?'))return;save({...data,maintenanceRequests:(data.maintenanceRequests||[]).filter(x=>x.id!==mid)})};
const getCompatParts=()=>{const eqId=sel?(sel.machineId||sel.truckId||sel.carId):'';return(data.parts||[]).filter(p=>p.quantity>0&&(!eqId||(p.compatibleWith||[]).length===0||(p.compatibleWith||[]).includes(eqId)))};
const confirmAddPart=()=>{if(!pickerPartId)return;const part=(data.parts||[]).find(p=>p.id===pickerPartId);if(!part)return;const qte=Math.min(pickerQte,part.quantity);if(qte<=0)return;setSel({...sel,partsUsed:[...(sel.partsUsed||[]),{partId:part.id,partName:part.name,quantity:qte,unitPrice:part.unitPrice,totalPrice:qte*part.unitPrice}]});setShowPartPicker(false);setPickerPartId('');setPickerQte(1)};
const removePartFromInter=(idx)=>{if(!sel)return;const pu=[...(sel.partsUsed||[])];pu.splice(idx,1);setSel({...sel,partsUsed:pu})};
return(
<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
<div style={{display:'flex',gap:6}}>
<button onClick={()=>setPanneTab('interventions')} style={btnStyle(C.accent,panneTab==='interventions')}>Interventions</button>
<button onClick={()=>setPanneTab('pannes')} style={btnStyle(C.orange,panneTab==='pannes')}>Pannes ({pannes.filter(p=>p.status!=='resolved').length})</button>
<button onClick={()=>setPanneTab('maintenance_requests')} style={btnStyle(C.cyan,panneTab==='maintenance_requests')}>Entretiens demandes ({maintReqs.filter(m=>m.status==='new').length})</button>
</div>
<button style={btnStyle(C.accent,true)} onClick={openAdd}>+ Intervention</button>
</div>
{panneTab==='interventions'&&<div>
<select style={{...inputStyle,width:200,marginBottom:12}} value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Tous equipements</option>{allEquip.map(eq=><option key={eq.id} value={eq.id}>({eq.t}) {eq.name}</option>)}</select>
{interventions.map(i=>(
<div key={i.id} style={{background:C.card,borderRadius:10,padding:12,marginBottom:8,border:'1px solid '+C.border}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
<div><span style={{fontWeight:700}}>{i.date}</span> <span style={{color:C.dim}}>| {i.type}</span> <span style={{color:C.accent}}>{i.machineId?equipName(i.machineId):i.truckId?equipName(i.truckId):i.carId?equipName(i.carId):'-'}</span></div>
<div style={{display:'flex',gap:4}}><span style={{fontWeight:700,color:C.red}}>{fmtMoney(i.totalCost||0)}</span>{isAdmin&&<button onClick={()=>delInter(i.id)} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:14}}>x</button>}<EBtn onClick={()=>openEdit(i)}/></div>
</div>
<div style={{fontSize:13,color:C.dim}}>{i.description}</div>
{(i.partsUsed||[]).length>0&&<div style={{fontSize:12,marginTop:4}}>{i.partsUsed.map((p,pi)=><span key={pi} style={{marginRight:8}}>{p.partName} x{p.quantity} ({fmtMoney(p.totalPrice)})</span>)}</div>}
{i.laborHours>0&&<div style={{fontSize:12,color:C.dim}}>MO: {i.laborHours}h {i.laborCost>0&&'= '+fmtMoney(i.laborCost)}</div>}
</div>))}
</div>}
{panneTab==='pannes'&&<div>
{pannes.map(p=>{const reporter=(data.employees||[]).find(e=>e.id===p.reportedBy);return(
<div key={p.id} style={{background:C.card,borderRadius:10,padding:12,marginBottom:8,border:'1px solid '+C.border,borderLeft:'3px solid '+(p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.muted)}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
<div><span style={{fontWeight:700}}>{p.date}</span> <Bg text={p.severity} color={p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.dim}/> <Bg text={p.status==='new'?'Nouvelle':p.status==='in_progress'?'En cours':'Resolue'} color={p.status==='resolved'?C.green:p.status==='in_progress'?C.orange:C.red}/></div>
<div style={{display:'flex',gap:4}}>
{p.status==='new'&&<button onClick={()=>updatePanneStatus(p.id,'in_progress')} style={{...btnStyle(C.orange),padding:'2px 8px',fontSize:11}}>Prendre en charge</button>}
{p.status==='in_progress'&&<button onClick={()=>updatePanneStatus(p.id,'resolved')} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>Resolu</button>}
</div></div>
<div style={{fontSize:13}}>{p.machineId?equipName(p.machineId):p.truckId?equipName(p.truckId):p.carId?equipName(p.carId):'-'}</div>
<div style={{fontSize:13,color:C.dim}}>{p.description}</div>
{reporter&&<div style={{fontSize:12,color:C.muted}}>Signale par: {reporter.name}</div>}
</div>)})}
</div>}
{panneTab==='maintenance_requests'&&<div>
{maintReqs.length===0&&<div style={{fontSize:14,color:C.dim,padding:24,textAlign:'center'}}>Aucune demande d'entretien.</div>}
{maintReqs.map(mr=>{const reporter=(data.employees||[]).find(e=>e.id===mr.reportedBy);const mach=(data.machines||[]).find(m=>m.id===mr.machineId);return(
<div key={mr.id} style={{background:C.card,borderRadius:10,padding:12,marginBottom:8,border:'1px solid '+C.border,borderLeft:'3px solid '+(mr.status==='done'?C.green:C.cyan)}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
<div><span style={{fontWeight:700}}>{mr.date}</span> <Bg text={mr.status==='done'?'Fait':'A faire'} color={mr.status==='done'?C.green:C.cyan}/></div>
<div style={{display:'flex',gap:4,alignItems:'center'}}>
{mr.status!=='done'&&<button onClick={()=>updateMaintStatus(mr.id,'done')} style={{...btnStyle(C.green),padding:'2px 10px',fontSize:12}}>Marquer fait</button>}
{mr.status==='done'&&<button onClick={()=>updateMaintStatus(mr.id,'new')} style={{...btnStyle(C.dim),padding:'2px 10px',fontSize:12}}>Rouvrir</button>}
{isAdmin&&<button onClick={()=>delMaintReq(mr.id)} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:16}}>x</button>}
</div>
</div>
<div style={{fontSize:13,fontWeight:600}}>{mach?mach.name+' ('+mach.type+')':'Machine inconnue'}</div>
<div style={{fontSize:13,color:C.dim,marginTop:2}}>{mr.description}</div>
{reporter&&<div style={{fontSize:12,color:C.muted,marginTop:2}}>Demande par: {reporter.name}</div>}
</div>)})}
</div>}
{showAdd&&sel&&<Mod title="Intervention" onClose={()=>{setShowAdd(false);setSel(null)}} width={550}>
<Fl label="Date"><input type="date" style={inputStyle} value={sel.date} onChange={e=>setSel({...sel,date:e.target.value})}/></Fl>
<Fl label="Equipement"><select style={inputStyle} value={sel.machineId||sel.truckId||sel.carId||''} onChange={e=>{const v=e.target.value;const eq=allEquip.find(x=>x.id===v);if(!eq)return setSel({...sel,machineId:'',truckId:'',carId:''});if(eq.t==='machine')setSel({...sel,machineId:v,truckId:'',carId:''});else if(eq.t==='camion')setSel({...sel,machineId:'',truckId:v,carId:''});else setSel({...sel,machineId:'',truckId:'',carId:v})}}><option value="">--</option>{allEquip.map(eq=><option key={eq.id} value={eq.id}>({eq.t}) {eq.name}</option>)}</select></Fl>
<Fl label="Type"><select style={inputStyle} value={sel.type} onChange={e=>setSel({...sel,type:e.target.value})}>{INTER_TYPES.map(t=><option key={t} value={t}>{t}</option>)}</select></Fl>
<Fl label="Description"><textarea style={{...inputStyle,height:60}} value={sel.description} onChange={e=>setSel({...sel,description:e.target.value})}/></Fl>
<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
<Fl label="Heures MO"><input type="number" style={inputStyle} value={sel.laborHours||0} onChange={e=>setSel({...sel,laborHours:Number(e.target.value)})}/></Fl>
<Fl label="Cout MO externe"><input type="number" style={inputStyle} value={sel.laborCost||0} onChange={e=>setSel({...sel,laborCost:Number(e.target.value)})}/></Fl>
</div>
<Fl label="Pieces utilisees">
{(sel.partsUsed||[]).map((p,i)=><div key={i} style={{fontSize:12,display:'flex',justifyContent:'space-between',alignItems:'center',padding:'2px 0',borderBottom:'1px solid #f1f5f9'}}><span>{p.partName} x{p.quantity}</span><span style={{display:'flex',gap:6,alignItems:'center'}}><span>{fmtMoney(p.totalPrice)}</span><button onClick={()=>removePartFromInter(i)} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:12}}>x</button></span></div>)}
{!showPartPicker&&<button onClick={()=>{setShowPartPicker(true);setPickerPartId('');setPickerQte(1)}} style={{...btnStyle(C.accent),padding:'2px 8px',fontSize:11,marginTop:4}}>+ Piece</button>}
{showPartPicker&&<div style={{background:'#f8fafc',borderRadius:8,padding:8,marginTop:4,border:'1px solid '+C.border}}>
<select style={{...inputStyle,marginBottom:4}} value={pickerPartId} onChange={e=>setPickerPartId(e.target.value)}><option value="">-- Choisir une piece --</option>{getCompatParts().map(p=><option key={p.id} value={p.id}>{p.name} ({p.category}) - stock: {p.quantity} - {fmtMoney(p.unitPrice)}/u</option>)}</select>
<div style={{display:'flex',gap:4,alignItems:'center'}}><input type="number" min="1" max={pickerPartId?(data.parts||[]).find(p=>p.id===pickerPartId)?.quantity||1:1} style={{...inputStyle,width:70}} value={pickerQte} onChange={e=>setPickerQte(Number(e.target.value)||1)} placeholder="Qte"/>
<button onClick={confirmAddPart} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>Ajouter</button>
<button onClick={()=>setShowPartPicker(false)} style={{...btnStyle(C.dim),padding:'2px 8px',fontSize:11}}>Annuler</button></div>
</div>}
</Fl>
<Fl label="Notes"><textarea style={{...inputStyle,height:40}} value={sel.notes||''} onChange={e=>setSel({...sel,notes:e.target.value})}/></Fl>
<div style={{display:'flex',gap:8,marginTop:12}}><button onClick={doSave} style={btnStyle(C.accent,true)}>Enregistrer</button><button onClick={()=>{setShowAdd(false);setSel(null)}} style={btnStyle(C.dim)}>Annuler</button></div>
</Mod>}
</div>)};

// ======== STATS / BREAK-EVEN ========
const StatsPage=({data})=>{
const wdpm=data.workDaysPerMonth||22;
const yearStart=data.yearStart||fmtDateISO(new Date(new Date().getFullYear(),0,1));
const allJobs=(data.jobs||[]).filter(j=>j.date>=yearStart&&j.type!=='depot');
const months=useMemo(()=>{const ms=[];const d=new Date(yearStart);for(let i=0;i<12;i++){const m=new Date(d.getFullYear(),d.getMonth()+i,1);const last=new Date(m.getFullYear(),m.getMonth()+1,0);ms.push({start:fmtDateISO(m),end:fmtDateISO(last),label:m.toLocaleString('fr-FR',{month:'short'})});if(m>new Date())break}return ms},[yearStart]);
const calcMachStats=(mach)=>{let cumCA=0,cumCost=0;const monthData=months.map(mo=>{const mJobs=allJobs.filter(j=>j.machineId===mach.id&&j.date>=mo.start&&j.date<=mo.end);const ca=mJobs.reduce((s,j)=>s+(j.priceForfait||0),0);const fuelCost=mJobs.reduce((s,j)=>{const ft=getMachineFuelType(data,mach.id);const fp=getFuelPrice(data,ft,j.machineFuelDepot);return s+(j.machineFuelL||0)*fp},0);const assJour=(mach.insuranceMonthly||0)/wdpm;const credJour=(Number(mach.creditMonthly)||0)/wdpm;const ctJour=((mach.ctCost||0)/12)/wdpm;const daysUsed=[...new Set(mJobs.map(j=>j.date))].length;const fixedCost=(assJour+credJour+ctJour)*daysUsed;const interCost=(data.interventions||[]).filter(i=>i.machineId===mach.id&&i.date>=mo.start&&i.date<=mo.end).reduce((s,i)=>s+(i.totalCost||0),0);const cost=fuelCost+fixedCost+interCost;cumCA+=ca;cumCost+=cost;return{label:mo.label,ca,cost,cumCA,cumCost}});return{monthData,totalCA:cumCA,totalCost:cumCost,result:cumCA-cumCost}};
const maxH=200;
return(
<div>
<h2 style={{marginBottom:16}}>Statistiques et Point mort</h2>
<h3 style={{marginBottom:8,color:C.accent}}>Machines</h3>
{(data.machines||[]).map(mach=>{const stats=calcMachStats(mach);const maxVal=Math.max(...stats.monthData.map(m=>Math.max(m.cumCA,m.cumCost)),1);const breakMonth=stats.monthData.find(m=>m.cumCA>=m.cumCost&&m.cumCA>0);return(
<div key={mach.id} style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:16}}>
<div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
<strong style={{color:MC[mach.type]||C.accent,fontSize:16}}>{mach.name}</strong>
<span style={{fontWeight:700,color:stats.result>=0?C.green:C.red,fontSize:15}}>{stats.result>=0?'+':''}{fmtMoney(stats.result)}</span>
</div>
<div style={{display:'flex',gap:16,marginBottom:12,fontSize:13}}>
<span>CA cumule: <b style={{color:C.green}}>{fmtMoney(stats.totalCA)}</b></span>
<span>Couts cumules: <b style={{color:C.red}}>{fmtMoney(stats.totalCost)}</b></span>
{breakMonth&&<span>Point mort: <b style={{color:C.accent}}>{breakMonth.label}</b></span>}
</div>
<div style={{display:'flex',alignItems:'flex-end',gap:2,height:maxH,marginBottom:8,background:'#f8fafc',borderRadius:8,padding:'8px 4px'}}>
{stats.monthData.map((m,i)=>{const hCA=(m.cumCA/maxVal)*maxH*0.9;const hCost=(m.cumCost/maxVal)*maxH*0.9;return(
<div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
<div style={{width:'100%',display:'flex',justifyContent:'center',gap:1,alignItems:'flex-end',height:maxH*0.9}}>
<div style={{width:'40%',height:Math.max(hCA,2),background:C.green,borderRadius:2,opacity:.7}}/>
<div style={{width:'40%',height:Math.max(hCost,2),background:C.red,borderRadius:2,opacity:.7}}/>
</div>
<div style={{fontSize:9,color:C.dim}}>{m.label}</div>
</div>)})}
</div>
<div style={{display:'flex',gap:12,fontSize:11,color:C.dim}}><span style={{display:'flex',alignItems:'center',gap:3}}><span style={{width:10,height:10,background:C.green,borderRadius:2,display:'inline-block'}}/> CA cumule</span><span style={{display:'flex',alignItems:'center',gap:3}}><span style={{width:10,height:10,background:C.red,borderRadius:2,display:'inline-block'}}/> Couts cumules</span></div>
</div>)})}
<h3 style={{marginBottom:8,marginTop:24,color:C.cyan}}>Camions</h3>
{(data.trucks||[]).map(truck=>{const truckJobs=allJobs.filter(j=>{const emp=(data.employees||[]).find(e=>e.id===j.employeeId);return emp&&emp.truckId===truck.id});const totalRevTransf=truckJobs.reduce((s,j)=>s+(j.hasTransfer?j.transferPrice||0:0),0);const totalFuelCost=truckJobs.reduce((s,j)=>{const ft=getMachineFuelType(data,j.machineId);const fp=getFuelPrice(data,'gazole',j.startFrom!=='home'?j.startFrom:null);const truckC=Number(truck.fuelPer100)||25;return s+((j.distanceKm||0)/100)*truckC*fp},0);const interCost=(data.interventions||[]).filter(i=>i.truckId===truck.id&&i.date>=yearStart).reduce((s,i)=>s+(i.totalCost||0),0);const fixedCost=((truck.insuranceMonthly||0)+(Number(truck.creditMonthly)||0)+((truck.ctCost||0)/12))*((new Date()-new Date(yearStart))/(30*86400000));const totalCost=totalFuelCost+interCost+fixedCost;const result=totalRevTransf-totalCost;return(
<div key={truck.id} style={{background:C.card,borderRadius:10,padding:14,border:'1px solid '+C.border,marginBottom:10}}>
<div style={{display:'flex',justifyContent:'space-between'}}><strong>{truck.name}</strong><span style={{fontWeight:700,color:result>=0?C.green:C.red}}>{result>=0?'+':''}{fmtMoney(result)}</span></div>
<div style={{fontSize:13,color:C.dim}}>Transferts: {fmtMoney(totalRevTransf)} | Carbu: {fmtMoney(totalFuelCost)} | Interventions: {fmtMoney(interCost)} | Fixes: {fmtMoney(fixedCost)}</div>
</div>)})}
</div>)};

// ======== MECHANIC VIEW ========
const MechanicView=({data,save,empId,onLogout})=>{
const emp=(data.employees||[]).find(e=>e.id===empId);
const[pg,setPg]=useState('stock');
if(!emp)return(<div>Employe non trouve</div>);
return(
<div style={{maxWidth:900,margin:'0 auto',padding:16}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,background:'#475569',color:'#fff',padding:'12px 16px',borderRadius:10}}>
<div style={{display:'flex',alignItems:'center',gap:10}}>
<div style={{width:40,height:40,borderRadius:'50%',background:'#fff3',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:18}}>{(emp.name||'?')[0].toUpperCase()}</div>
<div><div style={{fontWeight:700,fontSize:18}}>{emp.name}</div><div style={{fontSize:14,opacity:.8}}>Espace mecanicien</div></div>
</div>
<div style={{display:'flex',gap:6}}><button onClick={()=>{loadData().then(d2=>{if(d2){save(d2);alert('Actualisé !')}})}} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>↻</button><button onClick={onLogout} style={{background:'#fff3',border:'none',color:'#fff',padding:'8px 14px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:14}}>Deconnexion</button></div>
</div>
<div style={{display:'flex',gap:6,marginBottom:16}}>
<button onClick={()=>setPg('stock')} style={btnStyle('#475569',pg==='stock')}>Stock pieces</button>
<button onClick={()=>setPg('interventions')} style={btnStyle('#475569',pg==='interventions')}>Interventions</button>
<button onClick={()=>setPg('pannes')} style={btnStyle(C.orange,pg==='pannes')}>Pannes ({(data.panneReports||[]).filter(p=>p.status!=='resolved').length})</button>
</div>
{pg==='stock'&&<StockPage data={data} save={save} isAdmin={false}/>}
{pg==='interventions'&&<InterventionsPage data={data} save={save} isAdmin={false}/>}
{pg==='pannes'&&(()=>{const allEquip=[...(data.machines||[]).map(m=>({id:m.id,name:m.name,t:'machine'})),...(data.trucks||[]).map(t=>({id:t.id,name:t.name,t:'camion'})),...(data.cars||[]).map(c=>({id:c.id,name:c.name,t:'voiture'}))];const equipName=id=>{const e=allEquip.find(x=>x.id===id);return e?e.name:'?'};const pannes=(data.panneReports||[]).sort((a,b)=>b.date.localeCompare(a.date));const updatePanneStatus=(pid,status)=>{const nd=JSON.parse(JSON.stringify(data));const p=(nd.panneReports||[]).find(x=>x.id===pid);if(p){p.status=status;if(status==='resolved')p.resolvedDate=fmtDateISO(new Date());save(nd)}};return(<div>{pannes.map(p=>{const reporter=(data.employees||[]).find(e=>e.id===p.reportedBy);return(<div key={p.id} style={{background:C.card,borderRadius:10,padding:12,marginBottom:8,border:'1px solid '+C.border,borderLeft:'3px solid '+(p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.muted)}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}><div><span style={{fontWeight:700}}>{p.date}</span> <Bg text={p.severity} color={p.severity==='urgent'?C.red:p.severity==='normal'?C.orange:C.dim}/> <Bg text={p.status==='new'?'Nouvelle':p.status==='in_progress'?'En cours':'Resolue'} color={p.status==='resolved'?C.green:p.status==='in_progress'?C.orange:C.red}/></div><div style={{display:'flex',gap:4}}>{p.status==='new'&&<button onClick={()=>updatePanneStatus(p.id,'in_progress')} style={{...btnStyle(C.orange),padding:'2px 8px',fontSize:11}}>Prendre en charge</button>}{p.status==='in_progress'&&<button onClick={()=>updatePanneStatus(p.id,'resolved')} style={{...btnStyle(C.green),padding:'2px 8px',fontSize:11}}>Resolu</button>}</div></div><div style={{fontSize:13}}>{p.machineId?equipName(p.machineId):p.truckId?equipName(p.truckId):p.carId?equipName(p.carId):'-'}</div><div style={{fontSize:13,color:C.dim}}>{p.description}</div>{reporter&&<div style={{fontSize:12,color:C.muted}}>Signale par: {reporter.name}</div>}</div>)})}{pannes.length===0&&<div style={{color:C.dim,fontSize:14,padding:20,textAlign:'center'}}>Aucune panne signalee</div>}</div>)})()}
</div>)};

// ======== HEURES PAGE ========
const getISOWeek=(d)=>{const dt=new Date(d);dt.setHours(0,0,0,0);dt.setDate(dt.getDate()+3-(dt.getDay()+6)%7);const w1=new Date(dt.getFullYear(),0,4);return 1+Math.round(((dt-w1)/86400000-3+(w1.getDay()+6)%7)/7)};
const frDay=(d)=>{const dt=new Date(d);const jours=['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];const mois=['janv.','fevr.','mars','avr.','mai','juin','juil.','aout','sept.','oct.','nov.','dec.'];return jours[dt.getDay()]+' '+dt.getDate()+' '+mois[dt.getMonth()]};
const toDecHours=(startTime,endTime,pauseMin)=>{if(!startTime||!endTime)return 0;const[sh,sm]=(startTime||'0:0').split(':').map(Number);const[eh,em]=(endTime||'0:0').split(':').map(Number);let mins=(eh*60+em)-(sh*60+sm);if(mins<0)mins+=24*60;mins-=(pauseMin||0);return Math.round(Math.max(0,mins/60)*100)/100};
const calcSupp=(totalSemaine,seuil25,seuil50)=>{const h25=Math.max(0,Math.min(totalSemaine,seuil50)-seuil25);const h50=Math.max(0,totalSemaine-seuil50);return{h25,h50}};
const fmtDec=(n)=>n.toFixed(2).replace('.',',');
const HeuresPage=({data,save})=>{
const emps=data.employees||[];
const[selEmp,setSelEmp]=useState(emps[0]?.id||'');
const now=new Date();const mStart=now.getFullYear()+'-'+pad2(now.getMonth()+1)+'-01';const mEnd=fmtDateISO(new Date(now.getFullYear(),now.getMonth()+1,0));
const[dateStart,setDateStart]=useState(mStart);
const[dateEnd,setDateEnd]=useState(mEnd);
const seuil25=data.overtime25Threshold||35;const seuil50=data.overtime50Threshold||43;const refH=data.refHoursPerDay||1;
const empName=(emps.find(e=>e.id===selEmp)||{}).name||'';
// Get all dates in range
const allDates=useMemo(()=>{const dates=[];const d=new Date(dateStart);const end=new Date(dateEnd);while(d<=end){dates.push(fmtDateISO(d));d.setDate(d.getDate()+1)}return dates},[dateStart,dateEnd]);
// TimeEntries for this employee in range
const entries=useMemo(()=>(data.timeEntries||[]).filter(t=>t.empId===selEmp&&t.date>=dateStart&&t.date<=dateEnd).sort((a,b)=>a.date.localeCompare(b.date)),[data.timeEntries,selEmp,dateStart,dateEnd]);
// Validated entries
const validated=useMemo(()=>(data.timeEntriesValidated||[]).filter(t=>t.empId===selEmp&&t.date>=dateStart&&t.date<=dateEnd).sort((a,b)=>a.date.localeCompare(b.date)),[data.timeEntriesValidated,selEmp,dateStart,dateEnd]);
// Build rows per date for declared
const declaredRows=useMemo(()=>{return allDates.map(date=>{const holiday=getFrenchHoliday(date);const refDay=getDayRefHours(date);const te=entries.find(t=>t.date===date);if(!te)return{date,week:getISOWeek(date),empty:true,holiday,ref:refDay};const pauseMin=te.pauseMin||0;const worked=toDecHours(te.startTime,te.endTime,pauseMin);const brS=te.breakStart||te.pauseStart||'';const brE=te.breakEnd||te.pauseEnd||'';const createdAt=te.createdAt?new Date(te.createdAt):null;const horodateur=createdAt?pad2(createdAt.getDate())+'/'+pad2(createdAt.getMonth()+1)+' '+pad2(createdAt.getHours())+'h':'';return{date,week:getISOWeek(date),horodateur,absence:te.absenceType||'',start:te.startTime||'',breakStart:brS,meal:te.mealType||'',breakEnd:brE,end:te.endTime||'',worked,night:calcNightHours(te.startTime,te.endTime,data.nightStart||'21:00',data.nightEnd||'06:00'),ref:refDay,holiday,empty:false,id:te.id}})},[allDates,entries]);
// Build rows per date for validated
const validatedRows=useMemo(()=>{return allDates.map(date=>{const holiday=getFrenchHoliday(date);const refDay=getDayRefHours(date);const te=validated.find(t=>t.date===date);const orig=entries.find(t=>t.date===date);if(!te&&!orig)return{date,week:getISOWeek(date),empty:true,holiday,ref:refDay};if(!te&&orig){const pauseMin=orig.pauseMin||0;const worked=toDecHours(orig.startTime,orig.endTime,pauseMin);return{date,week:getISOWeek(date),start:orig.startTime||'',breakStart:orig.breakStart||orig.pauseStart||'',meal:orig.mealType||'PANIER',breakEnd:orig.breakEnd||orig.pauseEnd||'',end:orig.endTime||'',absence:orig.absenceType||'',night:calcNightHours(orig.startTime,orig.endTime,data.nightStart||'21:00',data.nightEnd||'06:00'),ref:refDay,holiday,worked,empty:false,fromDeclared:true}}const pauseMin2=te.breakStart&&te.breakEnd?((h,m)=>{const[sh2,sm2]=te.breakStart.split(':').map(Number);const[eh2,em2]=te.breakEnd.split(':').map(Number);return(eh2*60+em2)-(sh2*60+sm2)})(0,0):0;const worked2=toDecHours(te.startTime,te.endTime,pauseMin2);return{date,week:getISOWeek(date),start:te.startTime||'',breakStart:te.breakStart||'',meal:te.mealType||'',breakEnd:te.breakEnd||'',end:te.endTime||'',absence:te.absenceType||'',night:calcNightHours(te.startTime,te.endTime,data.nightStart||'21:00',data.nightEnd||'06:00'),ref:te.refHours!=null?te.refHours:refDay,holiday,worked:worked2,empty:false,fromDeclared:false,id:te.id}})},[allDates,validated,entries]);
// Group by week for totals
const weekTotals=(rows)=>{const wk={};rows.forEach(r=>{if(!wk[r.week])wk[r.week]={total:0,night:0};if(!r.empty&&!r.absence)wk[r.week].total+=r.worked;wk[r.week].night+=(r.night||0)});const result={};Object.keys(wk).forEach(w=>{const{h25,h50}=calcSupp(wk[w].total,seuil25,seuil50);result[w]={total:wk[w].total,h25,h50,night:wk[w].night}});return result};
const declWeeks=useMemo(()=>weekTotals(declaredRows),[declaredRows,seuil25,seuil50]);
const valWeeks=useMemo(()=>weekTotals(validatedRows),[validatedRows,seuil25,seuil50]);
// Period totals
const periodTotals=(wks)=>{let t=0,h25=0,h50=0,night=0;Object.values(wks).forEach(w=>{t+=w.total;h25+=w.h25;h50+=w.h50;night+=w.night});return{t,h25,h50,night}};
const declTot=periodTotals(declWeeks);const valTot=periodTotals(valWeeks);
// Update validated entry
const updateVal=(date,field,value)=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntriesValidated)nd.timeEntriesValidated=[];let idx=nd.timeEntriesValidated.findIndex(t=>t.empId===selEmp&&t.date===date);if(idx<0){const orig=(nd.timeEntries||[]).find(t=>t.empId===selEmp&&t.date===date);const base=orig?{startTime:orig.startTime||'',breakStart:orig.breakStart||orig.pauseStart||'',mealType:orig.mealType||'PANIER',breakEnd:orig.breakEnd||orig.pauseEnd||'',endTime:orig.endTime||'',absenceType:orig.absenceType||'',nightHours:orig.nightHours||0,refHours:refH}:{startTime:'',breakStart:'12:00',mealType:'PANIER',breakEnd:'13:00',endTime:'',absenceType:'',nightHours:0,refHours:refH};nd.timeEntriesValidated.push({id:uid(),empId:selEmp,date,...base});idx=nd.timeEntriesValidated.length-1}nd.timeEntriesValidated[idx][field]=value;save(nd)};
// Copy from declared
const copyFromDeclared=()=>{const nd=JSON.parse(JSON.stringify(data));if(!nd.timeEntriesValidated)nd.timeEntriesValidated=[];nd.timeEntriesValidated=nd.timeEntriesValidated.filter(t=>!(t.empId===selEmp&&t.date>=dateStart&&t.date<=dateEnd));entries.forEach(te=>{nd.timeEntriesValidated.push({id:uid(),empId:selEmp,date:te.date,startTime:te.startTime||'',breakStart:te.breakStart||te.pauseStart||'',mealType:te.mealType||'PANIER',breakEnd:te.breakEnd||te.pauseEnd||'',endTime:te.endTime||'',absenceType:te.absenceType||'',nightHours:te.nightHours||0,refHours:refH})});save(nd);alert('Heures copiees depuis declare !')};
// CSV export per table
const doExportCSV=(type)=>{const rows2=(type==='declared'?declaredRows:validatedRows).filter(r=>!r.empty);const label=type==='declared'?'declarees':'validees';let csv='Semaine;Date;Absence;Debut;Coupure;Repas;Reprise;Debauche;Travail;Ref;Nuit\n';rows2.forEach(r=>{csv+=r.week+';'+frDay(r.date)+';'+(r.absence||'')+';'+r.start+';'+r.breakStart+';'+r.meal+';'+r.breakEnd+';'+r.end+';'+fmtDec(r.worked)+';'+fmtDec(r.ref||0)+';'+fmtDec(r.night||0)+'\n'});const wks=type==='declared'?declWeeks:valWeeks;Object.keys(wks).forEach(w=>{const wk=wks[w];csv+='\nSemaine '+w+';'+fmtDec(wk.total)+';25%: '+fmtDec(wk.h25)+';50%: '+fmtDec(wk.h50)+';Nuit: '+fmtDec(wk.night)+'\n'});const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='soneco_heures_'+label+'_'+empName.replace(/\s/g,'_')+'_'+dateStart+'.csv';a.click();URL.revokeObjectURL(url)};
// Mail per table
const doMail=(type)=>{const rows2=(type==='declared'?declaredRows:validatedRows).filter(r=>!r.empty);const tots=type==='declared'?declTot:valTot;const wks=type==='declared'?declWeeks:valWeeks;const label=type==='declared'?'Heures declarees':'Heures validees';const subject='SONECO - '+label+' '+empName+' - '+dateStart+' au '+dateEnd;
// Construit le tableau HTML stylé (meme look que la page Heures)
let tbodyHtml='';let lastW=null;
rows2.forEach(r=>{
  if(lastW!==null&&r.week!==lastW&&wks[lastW]){const w=wks[lastW];tbodyHtml+='<tr style="background:#f1f5f9;font-weight:bold"><td colspan="9" style="padding:6px 8px;border:1px solid #cbd5e1;text-align:right;font-size:12px">Semaine '+lastW+' &nbsp;·&nbsp; Total <span style="color:#008965">'+fmtDec(w.total)+'h</span> &nbsp;·&nbsp; 25% <span style="color:#d97706">'+fmtDec(w.h25)+'h</span> &nbsp;·&nbsp; 50% <span style="color:#dc2626">'+fmtDec(w.h50)+'h</span> &nbsp;·&nbsp; Nuit <span style="color:#7c3aed">'+fmtDec(w.night)+'h</span></td></tr>'}
  lastW=r.week;
  tbodyHtml+='<tr><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px">'+r.week+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px">'+frDay(r.date)+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px;color:#dc2626">'+(r.absence||'')+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px;text-align:center">'+(r.start||'')+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px;text-align:center">'+(r.breakStart||'')+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px;text-align:center;color:'+(r.meal==='PANIER'?'#008965':'#d97706')+'">'+(r.meal||'')+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px;text-align:center">'+(r.breakEnd||'')+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:11px;text-align:center">'+(r.end||'')+'</td><td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:12px;text-align:right;font-weight:bold;color:#008965">'+fmtDec(r.worked)+'</td></tr>'
});
if(lastW!==null&&wks[lastW]){const w=wks[lastW];tbodyHtml+='<tr style="background:#f1f5f9;font-weight:bold"><td colspan="9" style="padding:6px 8px;border:1px solid #cbd5e1;text-align:right;font-size:12px">Semaine '+lastW+' &nbsp;·&nbsp; Total <span style="color:#008965">'+fmtDec(w.total)+'h</span> &nbsp;·&nbsp; 25% <span style="color:#d97706">'+fmtDec(w.h25)+'h</span> &nbsp;·&nbsp; 50% <span style="color:#dc2626">'+fmtDec(w.h50)+'h</span> &nbsp;·&nbsp; Nuit <span style="color:#7c3aed">'+fmtDec(w.night)+'h</span></td></tr>'}
const tableHtml='<div style="font-family:Arial,sans-serif"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px"><div><h2 style="margin:0;color:#008965;font-size:18px">SONECO — '+label+'</h2><div style="margin-top:4px;font-size:13px"><strong>'+empName+'</strong></div><div style="font-size:12px;color:#64748b">Du '+dateStart+' au '+dateEnd+'</div></div><div style="text-align:right;background:#f8fafc;border:1px solid #e2e8f0;padding:8px 12px;border-radius:8px;font-size:12px"><div style="font-weight:bold;margin-bottom:4px">Total periode</div><div>Travail <strong style="color:#008965">'+fmtDec(tots.t)+'h</strong></div><div>25% <strong style="color:#d97706">'+fmtDec(tots.h25)+'h</strong></div><div>50% <strong style="color:#dc2626">'+fmtDec(tots.h50)+'h</strong></div><div>Nuit <strong style="color:#7c3aed">'+fmtDec(tots.night)+'h</strong></div></div></div><table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif"><thead><tr style="background:#1e293b;color:#fff"><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px;text-align:left">Sem.</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px;text-align:left">Date</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px;text-align:left">Absence</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px">Debut</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px">Coupure</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px">Repas</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px">Reprise</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px">Debauche</th><th style="padding:6px 8px;border:1px solid #cbd5e1;font-size:11px">Travail</th></tr></thead><tbody>'+tbodyHtml+'</tbody></table></div>';
// Texte brut (fallback pour clients mail qui ne supportent pas HTML)
let body='SONECO - '+label+'\n\nSalarie : '+empName+'\nPeriode : '+dateStart+' au '+dateEnd+'\n\nTotale: '+fmtDec(tots.t)+'h | 25%: '+fmtDec(tots.h25)+'h | 50%: '+fmtDec(tots.h50)+'h | Nuit: '+fmtDec(tots.night)+'h\n';
// Page intermediaire : tableau visible + boutons Copier (HTML riche) + Ouvrir mail
const w=window.open('','_blank');
const fullHtml='<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+subject+'</title></head><body style="font-family:Arial,sans-serif;margin:20px;background:#f8fafc"><div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:10px;padding:14px 18px;margin-bottom:18px"><div style="font-weight:bold;font-size:15px;color:#92400e;margin-bottom:8px">📧 Comment envoyer par mail</div><ol style="margin:6px 0;padding-left:20px;font-size:13px;line-height:1.6;color:#78350f"><li>Cliquez sur <strong>« 📋 Copier le tableau »</strong></li><li>Cliquez ensuite sur <strong>« ✉️ Ouvrir mail »</strong> (ou ouvrez votre client mail manuellement)</li><li>Dans le corps du message, faites <strong>Ctrl+V</strong> (ou Cmd+V sur Mac) pour coller le tableau formate</li></ol><div style="display:flex;gap:8px;margin-top:10px"><button id="btnCopy" style="background:#16a34a;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:bold">📋 Copier le tableau</button><button id="btnMail" style="background:#0891b2;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:bold">✉️ Ouvrir mail</button><button onclick="window.print()" style="background:#64748b;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:bold">🖨 Imprimer</button><span id="ok" style="margin-left:auto;display:none;align-self:center;color:#15803d;font-weight:bold">✓ Copie !</span></div></div><div id="tbl" style="background:#fff;padding:18px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)">'+tableHtml+'</div><script>document.getElementById("btnCopy").onclick=async function(){try{const el=document.getElementById("tbl");const html=el.innerHTML;const txt=el.innerText;if(navigator.clipboard&&window.ClipboardItem){await navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([html],{type:"text/html"}),"text/plain":new Blob([txt],{type:"text/plain"})})])}else{const r=document.createRange();r.selectNode(el);window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.execCommand("copy");window.getSelection().removeAllRanges()}const ok=document.getElementById("ok");ok.style.display="inline-block";setTimeout(()=>{ok.style.display="none"},2500)}catch(e){alert("Erreur copie : "+e.message+"\\n\\nUtilisez Ctrl+A puis Ctrl+C manuellement.")}};document.getElementById("btnMail").onclick=function(){window.open("mailto:?subject="+encodeURIComponent('+JSON.stringify(subject)+')+"&body="+encodeURIComponent('+JSON.stringify(body)+'))};<\/script></body></html>';
w.document.write(fullHtml);w.document.close()};
// Print per table
const doPrint=(type)=>{const rows2=(type==='declared'?declaredRows:validatedRows).filter(r=>!r.empty);const tots=type==='declared'?declTot:valTot;const wks=type==='declared'?declWeeks:valWeeks;const label=type==='declared'?'Heures declarees':'Heures validees';let tbodyHtml='';let lastW3=null;rows2.forEach(r=>{if(lastW3!==null&&r.week!==lastW3&&wks[lastW3]){const w=wks[lastW3];tbodyHtml+='<tr class="week"><td colspan="11">Semaine '+lastW3+' : '+fmtDec(w.total)+'h &nbsp; 25%: '+fmtDec(w.h25)+'h &nbsp; 50%: '+fmtDec(w.h50)+'h &nbsp; Nuit: '+fmtDec(w.night)+'h</td></tr>'}lastW3=r.week;tbodyHtml+='<tr><td>'+r.week+'</td><td>'+frDay(r.date)+'</td><td>'+(r.absence||'')+'</td><td>'+r.start+'</td><td>'+r.breakStart+'</td><td>'+(r.meal||'')+'</td><td>'+r.breakEnd+'</td><td>'+r.end+'</td><td><b>'+fmtDec(r.worked)+'</b></td><td>'+fmtDec(r.ref||0)+'</td><td>'+fmtDec(r.night||0)+'</td></tr>'});if(lastW3!==null&&wks[lastW3]){const w=wks[lastW3];tbodyHtml+='<tr class="week"><td colspan="11">Semaine '+lastW3+' : '+fmtDec(w.total)+'h &nbsp; 25%: '+fmtDec(w.h25)+'h &nbsp; 50%: '+fmtDec(w.h50)+'h &nbsp; Nuit: '+fmtDec(w.night)+'h</td></tr>'}const html='<!DOCTYPE html><html><head><title>SONECO - '+label+' '+empName+'</title><style>body{font-family:Arial,sans-serif;font-size:11px;margin:20px}h1{font-size:16px;color:#008965;margin:0}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#f1f5f9;padding:5px 4px;text-align:left;font-size:10px;border:1px solid #e2e8f0}td{padding:4px;border:1px solid #e2e8f0}.week{background:#f8fafc;font-weight:bold;text-align:right}.totals{font-size:13px;font-weight:bold;text-align:right;margin:10px 0}@media print{body{margin:10px}}</style></head><body><div style="display:flex;justify-content:space-between"><div><h1>SONECO</h1><p><strong>'+empName+'</strong></p><p>'+label+'</p></div><div style="text-align:right"><p>Du '+dateStart+'</p><p>Au '+dateEnd+'</p></div></div><div class="totals">Totale: '+fmtDec(tots.t)+'h &nbsp; 25%: '+fmtDec(tots.h25)+'h &nbsp; 50%: '+fmtDec(tots.h50)+'h &nbsp; Nuit: '+fmtDec(tots.night)+'h</div><table><thead><tr><th>Sem.</th><th>Date</th><th>Absence</th><th>Debut</th><th>Coupure</th><th>Repas</th><th>Reprise</th><th>Debauche</th><th>Travail</th><th>Ref</th><th>Nuit</th></tr></thead><tbody>'+tbodyHtml+'</tbody></table></body></html>';const w2=window.open('','_blank');w2.document.write(html);w2.document.close();w2.print()};
// Table styles
const thS={fontSize:10,fontWeight:700,padding:'4px 3px',borderBottom:'2px solid '+C.border,background:'#f1f5f9',textAlign:'center',whiteSpace:'nowrap'};
const tdS={fontSize:11,padding:'3px 2px',borderBottom:'1px solid #f1f5f9',textAlign:'center',whiteSpace:'nowrap'};
const weekRowS={fontSize:11,fontWeight:700,padding:'4px 6px',background:'#e2e8f0',textAlign:'right'};
const inpTimeS={border:'1px solid #e2e8f0',background:'#f8fafc',borderRadius:4,fontSize:12,width:75,textAlign:'center',padding:'3px 4px'};
const inpSelS={border:'1px solid #e2e8f0',background:'#f8fafc',borderRadius:4,fontSize:11,width:68,textAlign:'center',padding:'3px 2px'};
const inpNumS={border:'1px solid #e2e8f0',background:'#f8fafc',borderRadius:4,fontSize:12,width:50,textAlign:'center',padding:'3px 4px'};
const smallBtnS={padding:'3px 8px',fontSize:11,borderRadius:4,cursor:'pointer',border:'1px solid '+C.border,background:'#f8fafc',color:C.dim,fontWeight:500,whiteSpace:'nowrap'};
// Render table
const renderTable=(rows,weeks,totals,editable)=>{let lastWeek=null;const trs=[];rows.forEach((r,i)=>{const isEven=i%2===0;const dow=(()=>{const d=new Date(r.date);return d.getDay()})();const isWeekend=dow===0||dow===6;const isHol=!!r.holiday;const bg=isHol?'#fef2f2':isWeekend?'#f1f5f9':(isEven?'#fafbfc':'#fff');
if(lastWeek!==null&&r.week!==lastWeek&&weeks[lastWeek]){const w=weeks[lastWeek];trs.push(<tr key={'w'+lastWeek}><td colSpan={11} style={weekRowS}>Semaine {lastWeek} : <span style={{color:C.accent}}>{fmtDec(w.total)}</span> <span style={{color:C.orange,marginLeft:8}}>25%: {fmtDec(w.h25)}</span> <span style={{color:C.red,marginLeft:8}}>50%: {fmtDec(w.h50)}</span> <span style={{color:C.purple,marginLeft:8}}>Nuit: {fmtDec(w.night)}</span></td></tr>)}lastWeek=r.week;
const dateCell=<td style={{...tdS,textAlign:'left',fontSize:10}}>{frDay(r.date)}{isHol&&<div style={{fontSize:9,color:'#dc2626',fontWeight:700,marginTop:1}}>🎉 {r.holiday}</div>}</td>;
if(r.empty){trs.push(<tr key={r.date} style={{background:bg}}><td style={tdS}></td><td style={tdS}>{r.week}</td>{dateCell}<td colSpan={7} style={{...tdS,color:isHol?'#dc2626':C.muted,fontStyle:'italic',fontWeight:isHol?700:400}}>{isHol?('🎉 '+r.holiday):(isWeekend?'Weekend':'—')}</td><td style={{...tdS,color:C.dim,fontSize:10}}>{r.ref>0?fmtDec(r.ref)+'h':''}</td></tr>);return}
const origRow=editable?declaredRows.find(d=>d.date===r.date):null;
const isDiff=(field)=>editable&&origRow&&!origRow.empty&&origRow[field]!==r[field];
const cellBg=(field)=>isDiff(field)?'#fff7ed':'transparent';
if(!editable){trs.push(<tr key={r.date} style={{background:bg}}><td style={tdS}>{r.horodateur||''}</td><td style={tdS}>{r.week}</td>{dateCell}<td style={{...tdS,color:r.absence?C.red:C.dim}}>{r.absence||''}</td><td style={tdS}>{r.start}</td><td style={tdS}>{r.breakStart}</td><td style={{...tdS,fontWeight:600,color:r.meal==='PANIER'?C.accent:C.orange}}>{r.meal}</td><td style={tdS}>{r.breakEnd}</td><td style={tdS}>{r.end}</td><td style={{...tdS,fontWeight:600}}>{fmtDec(r.worked)}</td><td style={tdS}>{fmtDec(r.ref||0)} <span style={{color:C.purple}}>{fmtDec(r.night||0)}</span></td></tr>)}else{
trs.push(<tr key={r.date} style={{background:bg}}><td style={tdS}></td><td style={tdS}>{r.week}</td>{dateCell}<td style={{...tdS,background:cellBg('absence')}}><select value={r.absence||''} onChange={e=>updateVal(r.date,'absenceType',e.target.value)} style={{...inpSelS,background:cellBg('absence')||'#f8fafc'}}><option value=""></option><option value="maladie">Maladie</option><option value="conge">Conge</option><option value="rtt">RTT</option><option value="autre">Autre</option></select></td><td style={{...tdS,background:cellBg('start')}}><input type="time" value={r.start} onChange={e=>updateVal(r.date,'startTime',e.target.value)} style={{...inpTimeS,background:cellBg('start')||'#f8fafc'}}/></td><td style={{...tdS,background:cellBg('breakStart')}}><input type="time" value={r.breakStart} onChange={e=>updateVal(r.date,'breakStart',e.target.value)} style={{...inpTimeS,background:cellBg('breakStart')||'#f8fafc'}}/></td><td style={{...tdS,background:cellBg('meal')}}><select value={r.meal} onChange={e=>updateVal(r.date,'mealType',e.target.value)} style={{...inpSelS,background:cellBg('meal')||'#f8fafc',fontWeight:600,color:r.meal==='PANIER'?C.accent:C.orange}}><option value="PANIER">PANIER</option><option value="RESTO">RESTO</option></select></td><td style={{...tdS,background:cellBg('breakEnd')}}><input type="time" value={r.breakEnd} onChange={e=>updateVal(r.date,'breakEnd',e.target.value)} style={{...inpTimeS,background:cellBg('breakEnd')||'#f8fafc'}}/></td><td style={{...tdS,background:cellBg('end')}}><input type="time" value={r.end} onChange={e=>updateVal(r.date,'endTime',e.target.value)} style={{...inpTimeS,background:cellBg('end')||'#f8fafc'}}/></td><td style={{...tdS,fontWeight:600}}>{fmtDec(r.worked)}</td><td style={{...tdS,color:C.purple,fontWeight:600}} title="Calcul automatique selon la plage nuit configuree dans les Parametres">{fmtDec(r.night||0)}</td></tr>)}});
if(lastWeek!==null&&weeks[lastWeek]){const w=weeks[lastWeek];trs.push(<tr key={'w'+lastWeek}><td colSpan={11} style={weekRowS}>Semaine {lastWeek} : <span style={{color:C.accent}}>{fmtDec(w.total)}</span> <span style={{color:C.orange,marginLeft:8}}>25%: {fmtDec(w.h25)}</span> <span style={{color:C.red,marginLeft:8}}>50%: {fmtDec(w.h50)}</span> <span style={{color:C.purple,marginLeft:8}}>Nuit: {fmtDec(w.night)}</span></td></tr>)}
return(<table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}><thead><tr><th style={thS}>Horodateur</th><th style={thS}>Sem.</th><th style={{...thS,textAlign:'left'}}>DATE</th><th style={thS}>ABSENCE</th><th style={thS}>DEBUT</th><th style={thS}>COUPURE</th><th style={thS}>REPAS</th><th style={thS}>REPRISE</th><th style={thS}>DEBAUCHE</th><th style={thS}>Tps tr.</th><th style={thS}>Ref/Nuit</th></tr></thead><tbody>{trs}</tbody></table>)};
return(
<div>
<h2 style={{marginBottom:16}}>Heures</h2>
<div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
<Fl label="Salarie"><select style={{...inputStyle,width:180}} value={selEmp} onChange={e=>setSelEmp(e.target.value)}>{emps.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></Fl>
<Fl label="Debut"><input type="date" style={{...inputStyle,width:150}} value={dateStart} onChange={e=>setDateStart(e.target.value)}/></Fl>
<Fl label="Fin"><input type="date" style={{...inputStyle,width:150}} value={dateEnd} onChange={e=>setDateEnd(e.target.value)}/></Fl>
</div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,marginBottom:20,overflow:'auto'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4,flexWrap:'wrap',gap:6}}>
<h3 style={{margin:0,fontSize:15}}>&#128274; Heures declarees par {empName}</h3>
<div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
<div style={{fontSize:12,display:'flex',gap:10,marginRight:8}}>
<span>totale <b style={{color:C.accent}}>{fmtDec(declTot.t)}</b></span>
<span>25% <b style={{color:C.orange}}>{fmtDec(declTot.h25)}</b></span>
<span>50% <b style={{color:C.red}}>{fmtDec(declTot.h50)}</b></span>
<span>Nuit <b style={{color:C.purple}}>{fmtDec(declTot.night)}</b></span>
</div>
<button onClick={()=>doMail('declared')} style={smallBtnS}>&#128231; Mail</button>
<button onClick={()=>doPrint('declared')} style={smallBtnS}>&#128424; Imprimer</button>
<button onClick={()=>doExportCSV('declared')} style={smallBtnS}>&#128229; CSV</button>
</div>
</div>
{renderTable(declaredRows,declWeeks,declTot,false)}
</div>
<div style={{background:C.card,borderRadius:12,padding:16,border:'1px solid '+C.border,overflow:'auto'}}>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4,flexWrap:'wrap',gap:6}}>
<h3 style={{margin:0,fontSize:15}}>&#9998; Heures validees — {empName}</h3>
<div style={{display:'flex',gap:4,alignItems:'center',flexWrap:'wrap'}}>
<div style={{fontSize:12,display:'flex',gap:10,marginRight:8}}>
<span>totale <b style={{color:C.accent}}>{fmtDec(valTot.t)}</b></span>
<span>25% <b style={{color:C.orange}}>{fmtDec(valTot.h25)}</b></span>
<span>50% <b style={{color:C.red}}>{fmtDec(valTot.h50)}</b></span>
<span>Nuit <b style={{color:C.purple}}>{fmtDec(valTot.night)}</b></span>
</div>
<button onClick={copyFromDeclared} style={{...smallBtnS,background:'#f0fdfa',color:C.cyan,borderColor:C.cyan}}>Copier depuis declare</button>
<button onClick={()=>doMail('validated')} style={smallBtnS}>&#128231; Mail</button>
<button onClick={()=>doPrint('validated')} style={smallBtnS}>&#128424; Imprimer</button>
<button onClick={()=>doExportCSV('validated')} style={smallBtnS}>&#128229; CSV</button>
</div>
</div>
{renderTable(validatedRows,valWeeks,valTot,true)}
</div>
</div>)};

// ======== RECHERCHE DATA ========
const SearchDataPage=({data})=>{
const[query,setQuery]=useState('');const[results,setResults]=useState(null);const[loading,setLoading]=useState(false);
const empName=id=>{const e=(data.employees||[]).find(x=>x.id===id);return e?e.name:'?'};
const machName=id=>{const m=(data.machines||[]).find(x=>x.id===id);return m?m.name:'?'};
const clientName=id=>{const c=(data.clients||[]).find(x=>x.id===id);return c?c.name:'?'};
const depotName=id=>{if(id==='home')return'Domicile';const d=(data.depots||[]).find(x=>x.id===id);return d?d.name:'?'};
const parseQuery=(q)=>{
const ql=q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
let dateFrom=null,dateTo=null;
const dateMatch=ql.match(/(?:a partir|depuis|du|from)\s+(?:du\s+)?(\d{1,2})[\/\-\s](\d{1,2}|\w+)[\/\-\s](\d{4})/);
if(dateMatch){const[,d,m,y]=dateMatch;const months={'janvier':'01','fevrier':'02','mars':'03','avril':'04','mai':'05','juin':'06','juillet':'07','aout':'08','septembre':'09','octobre':'10','novembre':'11','decembre':'12'};const mo=months[m]||String(m).padStart(2,'0');dateFrom=y+'-'+mo+'-'+String(d).padStart(2,'0')}
const dateToMatch=ql.match(/(?:jusqu.?au?|au|to)\s+(\d{1,2})[\/\-\s](\d{1,2}|\w+)[\/\-\s](\d{4})/);
if(dateToMatch){const[,d,m,y]=dateToMatch;const months={'janvier':'01','fevrier':'02','mars':'03','avril':'04','mai':'05','juin':'06','juillet':'07','aout':'08','septembre':'09','octobre':'10','novembre':'11','decembre':'12'};const mo=months[m]||String(m).padStart(2,'0');dateTo=y+'-'+mo+'-'+String(d).padStart(2,'0')}
if(!dateFrom){const y2=ql.match(/(\d{4})/);if(y2)dateFrom=y2[1]+'-01-01'}
if(!dateTo)dateTo=fmtDateISO(new Date());
let empFilter=null;
(data.employees||[]).forEach(e=>{if(ql.includes(e.name.toLowerCase()))empFilter=e.id});
return{ql,dateFrom,dateTo,empFilter};
};
const doSearch=()=>{
if(!query.trim())return;
setLoading(true);
const{ql,dateFrom,dateTo,empFilter}=parseQuery(query);
const res={title:'',headers:[],rows:[],summary:''};
// Embauche trop tot / surcout embauche
if(ql.includes('embauche')||(ql.includes('surcout')&&ql.includes('emb'))||(ql.includes('trop')&&ql.includes('tot'))){
res.title='Embauches trop tot'+(empFilter?' — '+empName(empFilter):'');
res.headers=['Date','Chauffeur','Machine','Client','Theo','Reel','Avance (min)','Surcout'];
let totalSurcout=0;
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo&&(!empFilter||j.employeeId===empFilter)).forEach(j=>{
const emp2=(data.employees||[]).find(e=>e.id===j.employeeId);if(!emp2)return;
const te=(data.timeEntries||[]).filter(t=>t.empId===j.employeeId&&t.date===j.date);
const mainTE2=te.find(t=>t.startTime&&t.endTime)||te.find(t=>t.startTime);
if(!mainTE2||!mainTE2.startTime)return;
const theo=calcTheoreticalTimes(j,data,mainTE2?mainTE2.pauseMin||0:0);
if(!theo)return;
const[ah,am]=mainTE2.startTime.split(':').map(Number);
const actualMin=ah*60+am;
const diff=theo.theoStartMin-actualMin;
if(diff>0){
const hr=emp2.salaryType==='monthly'?0:Number(emp2.hourlySalary)||0;
const surcout=(diff/60)*hr;
totalSurcout+=surcout;
res.rows.push([j.date,emp2.name,machName(j.machineId),clientName(j.clientId),theo.theoStart,mainTE2.startTime,'+'+diff+'min',fmtMoney(surcout)])}});
res.rows.sort((a,b)=>b[0].localeCompare(a[0]));
res.summary='Total surcout embauche: '+fmtMoney(totalSurcout)+' | '+res.rows.length+' occurrences';
}
// Debauche tard / surcout debauche
else if(ql.includes('debauche')||(ql.includes('surcout')&&ql.includes('deb'))||(ql.includes('trop')&&ql.includes('tard'))){
res.title='Debauches tardives'+(empFilter?' — '+empName(empFilter):'');
res.headers=['Date','Chauffeur','Machine','Client','Theo','Reel','Depassement','Surcout'];
let totalSurcout=0;
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo&&(!empFilter||j.employeeId===empFilter)).forEach(j=>{
const emp2=(data.employees||[]).find(e=>e.id===j.employeeId);if(!emp2)return;
const te=(data.timeEntries||[]).filter(t=>t.empId===j.employeeId&&t.date===j.date);
const mainTE2=te.find(t=>t.startTime&&t.endTime);
if(!mainTE2||!mainTE2.endTime)return;
const theo=calcTheoreticalTimes(j,data,mainTE2?mainTE2.pauseMin||0:0);
if(!theo)return;
const[eh,em]=mainTE2.endTime.split(':').map(Number);
const actualMin=eh*60+em;
const diff=actualMin-theo.theoEndMin;
if(diff>0){
const hr=emp2.salaryType==='monthly'?0:Number(emp2.hourlySalary)||0;
const surcout=(diff/60)*hr;
totalSurcout+=surcout;
res.rows.push([j.date,emp2.name,machName(j.machineId),clientName(j.clientId),theo.theoEnd,mainTE2.endTime,'+'+diff+'min',fmtMoney(surcout)])}});
res.rows.sort((a,b)=>b[0].localeCompare(a[0]));
res.summary='Total surcout debauche: '+fmtMoney(totalSurcout)+' | '+res.rows.length+' occurrences';
}
// CA par client
else if(ql.includes('ca')&&(ql.includes('client')||ql.includes('chiffre'))){
res.title='CA par client';
res.headers=['Client','Nb missions','CA Forfaits','CA Transferts','CA Total'];
const byClient={};
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo).forEach(j=>{
const cn=clientName(j.clientId);if(!byClient[cn])byClient[cn]={missions:0,forfaits:0,transferts:0};
byClient[cn].missions++;byClient[cn].forfaits+=(j.priceForfait||0);byClient[cn].transferts+=(j.hasTransfer?j.transferPrice||0:0)});
Object.entries(byClient).sort((a,b)=>(b[1].forfaits+b[1].transferts)-(a[1].forfaits+a[1].transferts)).forEach(([n,v])=>{
res.rows.push([n,v.missions,fmtMoney(v.forfaits),fmtMoney(v.transferts),fmtMoney(v.forfaits+v.transferts)])});
const totF=Object.values(byClient).reduce((s,v)=>s+v.forfaits,0);
const totT=Object.values(byClient).reduce((s,v)=>s+v.transferts,0);
res.summary='Total: '+fmtMoney(totF+totT)+' (Forfaits: '+fmtMoney(totF)+' | Transferts: '+fmtMoney(totT)+')';
}
// CA par chauffeur
else if(ql.includes('ca')&&(ql.includes('chauffeur')||ql.includes('employe')||ql.includes('conducteur'))){
res.title='CA par chauffeur';
res.headers=['Chauffeur','Nb missions','CA Forfaits','CA Transferts','CA Total'];
const byEmp={};
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo).forEach(j=>{
const en=empName(j.employeeId);if(!byEmp[en])byEmp[en]={missions:0,forfaits:0,transferts:0};
byEmp[en].missions++;byEmp[en].forfaits+=(j.priceForfait||0);byEmp[en].transferts+=(j.hasTransfer?j.transferPrice||0:0)});
Object.entries(byEmp).sort((a,b)=>(b[1].forfaits+b[1].transferts)-(a[1].forfaits+a[1].transferts)).forEach(([n,v])=>{
res.rows.push([n,v.missions,fmtMoney(v.forfaits),fmtMoney(v.transferts),fmtMoney(v.forfaits+v.transferts)])});
res.summary='Total: '+fmtMoney(Object.values(byEmp).reduce((s,v)=>s+v.forfaits+v.transferts,0));
}
// CA par machine
else if(ql.includes('ca')&&ql.includes('machine')){
res.title='CA par machine';
res.headers=['Machine','Type','Nb missions','CA Total'];
const byM={};
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo).forEach(j=>{
const m=(data.machines||[]).find(x=>x.id===j.machineId);const mn=m?m.name:'?';const mt=m?m.type:'?';
if(!byM[mn])byM[mn]={type:mt,missions:0,ca:0};byM[mn].missions++;byM[mn].ca+=(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0)});
Object.entries(byM).sort((a,b)=>b[1].ca-a[1].ca).forEach(([n,v])=>{res.rows.push([n,v.type,v.missions,fmtMoney(v.ca)])});
res.summary='Total: '+fmtMoney(Object.values(byM).reduce((s,v)=>s+v.ca,0));
}
// Heures par employe
else if(ql.includes('heure')||ql.includes('pointage')||ql.includes('travail')){
res.title='Heures de travail'+(empFilter?' — '+empName(empFilter):'');
res.headers=['Date','Chauffeur','Embauche','Debauche','Pause','Travail'];
let totalH=0;
(data.timeEntries||[]).filter(t=>t.date>=(dateFrom||'2020-01-01')&&t.date<=dateTo&&(!empFilter||t.empId===empFilter)&&t.startTime&&t.endTime).sort((a,b)=>b.date.localeCompare(a.date)).forEach(t=>{
const wm=calcWorkedMin(t);totalH+=wm;
res.rows.push([t.date,empName(t.empId),t.startTime,t.endTime,(t.pauseMin||0)+'min',fmtDuration(wm)])});
res.summary='Total: '+fmtDuration(totalH)+' ('+((totalH/60).toFixed(2))+'h)';
}
// Pannes
else if(ql.includes('panne')){
res.title='Pannes signalees';
res.headers=['Date','Equipement','Severite','Status','Description','Signale par'];
(data.panneReports||[]).filter(p=>p.date>=(dateFrom||'2020-01-01')&&p.date<=dateTo).sort((a,b)=>b.date.localeCompare(a.date)).forEach(p=>{
const eqN=p.machineId?machName(p.machineId):p.truckId?((data.trucks||[]).find(x=>x.id===p.truckId)||{}).name||'?':'?';
res.rows.push([p.date,eqN,p.severity,p.status==='new'?'Nouvelle':p.status==='in_progress'?'En cours':'Resolue',p.description||'',empName(p.reportedBy)])});
res.summary=res.rows.length+' pannes';
}
// Interventions / entretien
else if(ql.includes('intervention')||ql.includes('entretien')||ql.includes('reparation')){
res.title='Interventions';
res.headers=['Date','Equipement','Type','Cout','Description'];
let totalC=0;
(data.interventions||[]).filter(i=>i.date>=(dateFrom||'2020-01-01')&&i.date<=dateTo).sort((a,b)=>b.date.localeCompare(a.date)).forEach(i=>{
const eqN=i.machineId?machName(i.machineId):i.truckId?((data.trucks||[]).find(x=>x.id===i.truckId)||{}).name||'?':'?';
totalC+=(i.totalCost||0);
res.rows.push([i.date,eqN,i.type,fmtMoney(i.totalCost||0),i.description||''])});
res.summary='Total cout: '+fmtMoney(totalC)+' | '+res.rows.length+' interventions';
}
// Missions / chantiers
else if(ql.includes('mission')||ql.includes('chantier')||ql.includes('forfait')){
res.title='Missions'+(empFilter?' — '+empName(empFilter):'');
res.headers=['Date','Chauffeur','Machine','Client','Lieu','Forfait','Prix','Transfert'];
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo&&(!empFilter||j.employeeId===empFilter)).sort((a,b)=>b.date.localeCompare(a.date)).forEach(j=>{
res.rows.push([j.date,empName(j.employeeId),machName(j.machineId),clientName(j.clientId),(j.location||'').slice(0,30),j.forfaitType,fmtMoney(j.priceForfait||0),j.hasTransfer?fmtMoney(j.transferPrice||0):'-'])});
res.summary=res.rows.length+' missions | CA: '+fmtMoney(res.rows.reduce((s,r)=>s+parseFloat((r[6]||'0').replace(',','.').replace(' EUR','')),0));
}
// Km / kilometres
else if(ql.includes('km')||ql.includes('kilometre')||ql.includes('trajet')||ql.includes('distance')){
res.title='Kilometres'+(empFilter?' — '+empName(empFilter):'');
res.headers=['Date','Chauffeur','Client','Depart','Arrivee','Km Aller','Km Retour','Total km'];
let totalKm=0;
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo&&(!empFilter||j.employeeId===empFilter)&&(j.kmAller>0||j.kmRetour>0)).sort((a,b)=>b.date.localeCompare(a.date)).forEach(j=>{
const tk=(j.kmAller||0)+(j.kmRetour||0);totalKm+=tk;
res.rows.push([j.date,empName(j.employeeId),clientName(j.clientId),depotName(j.startFrom),depotName(j.endAt),(j.kmAller||0).toFixed(0),(j.kmRetour||0).toFixed(0),tk.toFixed(0)])});
res.summary='Total: '+totalKm.toFixed(0)+' km | '+res.rows.length+' trajets';
}
// Carburant
else if(ql.includes('carburant')||ql.includes('gasoil')||ql.includes('gnr')||ql.includes('fuel')){
res.title='Consommation carburant'+(empFilter?' — '+empName(empFilter):'');
res.headers=['Date','Chauffeur','Machine','Litres machine','Cout'];
let totalL=0,totalC=0;
(data.jobs||[]).filter(j=>j.type!=='depot'&&j.date>=(dateFrom||'2020-01-01')&&j.date<=dateTo&&(!empFilter||j.employeeId===empFilter)&&(j.machineFuelL||0)>0).sort((a,b)=>b.date.localeCompare(a.date)).forEach(j=>{
const ft=getMachineFuelType(data,j.machineId);const fp=getFuelPrice(data,ft,j.machineFuelDepot);const cost=(j.machineFuelL||0)*fp;
totalL+=(j.machineFuelL||0);totalC+=cost;
res.rows.push([j.date,empName(j.employeeId),machName(j.machineId),(j.machineFuelL||0)+'L',fmtMoney(cost)])});
res.summary='Total: '+totalL.toFixed(0)+'L | Cout: '+fmtMoney(totalC);
}
// Defaut : toutes les missions
else{
res.title='Recherche: "'+query+'"';
res.headers=['Info'];
res.rows=[['Exemples de recherches:'],['embauche trop tot par employe a partir de 1 janvier 2026'],['debauche tardive a partir du 1/1/2026'],['ca par client a partir du 1/1/2026'],['ca par chauffeur a partir du 1/1/2026'],['ca par machine'],['heures par employe'],['missions a partir du 1/3/2026'],['pannes'],['interventions'],['km par employe'],['carburant a partir du 1/1/2026']];
res.summary='Tapez une recherche ci-dessus';}
setResults(res);setLoading(false)};
const exportCSV=()=>{if(!results)return;let csv=results.headers.join(';')+'\n';results.rows.forEach(r=>{csv+=r.join(';')+'\n'});
const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='recherche_'+query.replace(/\s/g,'_')+'.csv';a.click()};
return(
<div>
<h2 style={{margin:'0 0 16px'}}>Recherche donnees</h2>
<div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
<input style={{...inputStyle,flex:1,fontSize:15,padding:'10px 14px'}} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')doSearch()}} placeholder="Ex: embauche trop tot par employe a partir de 1 janvier 2026"/>
<button onClick={doSearch} style={{...btnStyle(C.accent,true),fontSize:15,padding:'10px 20px'}}>Rechercher</button>
</div>
{!results&&<div style={{background:C.card,borderRadius:12,padding:20,border:'1px solid '+C.border}}>
<div style={{fontSize:15,fontWeight:600,marginBottom:12}}>Exemples de recherches :</div>
<div style={{display:'flex',flexDirection:'column',gap:6}}>
{['embauche trop tot a partir de 1 janvier 2026','debauche tardive a partir du 1/1/2026','ca par client a partir du 1/1/2026','ca par chauffeur','ca par machine','heures jerome a partir du 1/3/2026','missions franck','pannes','interventions','km par employe','carburant a partir du 1/1/2026'].map((ex,i)=>
<div key={i} onClick={()=>{setQuery(ex);}} style={{cursor:'pointer',padding:'6px 12px',borderRadius:8,background:'#f8fafc',border:'1px solid '+C.border,fontSize:14,color:C.accent}}>{ex}</div>)}
</div>
</div>}
{results&&<div>
<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
<h3 style={{margin:0,fontSize:16}}>{results.title}</h3>
<div style={{display:'flex',gap:6}}>
<button onClick={exportCSV} style={{...btnStyle(C.accent),fontSize:13}}>CSV</button>
<span style={{fontSize:13,color:C.dim}}>{results.rows.length} resultats</span>
</div>
</div>
{results.summary&&<div style={{background:'#00896508',border:'1px solid #00896520',borderRadius:8,padding:'8px 14px',marginBottom:12,fontSize:14,fontWeight:600,color:C.accent}}>{results.summary}</div>}
<div style={{overflowX:'auto',background:C.card,borderRadius:10,border:'1px solid '+C.border}}>
<table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
<thead><tr style={{background:'#f1f5f9'}}>{results.headers.map((h,i)=><th key={i} style={{padding:'8px 10px',textAlign:'left',fontWeight:700,fontSize:12,borderBottom:'2px solid '+C.border,whiteSpace:'nowrap'}}>{h}</th>)}</tr></thead>
<tbody>{results.rows.map((r,ri)=><tr key={ri} style={{background:ri%2===0?'#fff':'#f8fafc',borderBottom:'1px solid #f1f5f9'}}>{r.map((c,ci)=><td key={ci} style={{padding:'6px 10px',whiteSpace:'nowrap'}}>{c}</td>)}</tr>)}</tbody>
</table>
</div>
</div>}
</div>)};

// ======== ADMIN PANEL ========
const AdminPanel=({data,save,onLogout,onUndo})=>{
const[pg,setPg]=useState('planning');const[mobOpen,setMobOpen]=useState(false);const[sbHidden,setSbHidden]=useState(false);
const pages=[{k:'planning',l:'Planning',i:'&#128197;'},{k:'dashboard',l:'Dashboard',i:'&#128200;'},{k:'depots',l:'Depots',i:'&#127981;'},{k:'machines',l:'Machines',i:'&#9881;'},{k:'equipements',l:'Equipements',i:'&#129520;'},{k:'trucks',l:'Camions',i:'&#128666;'},{k:'cars',l:'Voitures',i:'&#128663;'},{k:'employees',l:'Employes',i:'&#128100;'},{k:'clients',l:'Clients',i:'&#128188;'},{k:'forfaits',l:'Forfaits',i:'&#128176;'},{k:'heures',l:'Heures',i:'&#128337;'},{k:'stock',l:'Stock',i:'&#128230;'},{k:'interventions',l:'Interventions',i:'&#128295;'},{k:'stats',l:'Stats',i:'&#128202;'},{k:'recherche',l:'Recherche',i:'&#128269;'},{k:'settings',l:'Parametres',i:'&#9881;'}];
const content=()=>{switch(pg){case'planning':return(<PlanningPage data={data} save={save} sbHidden={sbHidden} setSbHidden={setSbHidden}/>);case'dashboard':return(<DashboardPage data={data}/>);case'depots':return(<DepotsPage data={data} save={save}/>);case'machines':return(<MachinesPage data={data} save={save}/>);case'equipements':return(<EquipmentListsPage data={data} save={save}/>);case'trucks':return(<TrucksPage data={data} save={save}/>);case'cars':return(<CarsPage data={data} save={save}/>);case'employees':return(<EmployeesPage data={data} save={save}/>);case'clients':return(<ClientsPage data={data} save={save}/>);case'forfaits':return(<ForfaitsPage data={data} save={save}/>);case'heures':return(<HeuresPage data={data} save={save}/>);case'stock':return(<StockPage data={data} save={save} isAdmin={true}/>);case'interventions':return(<InterventionsPage data={data} save={save} isAdmin={true}/>);case'stats':return(<StatsPage data={data}/>);case'recherche':return(<SearchDataPage data={data}/>);case'settings':return(<SettingsPage data={data} save={save}/>);default:return null}};
return(
<div>
{mobOpen&&<div className="sb-overlay" style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.3)',zIndex:199}} onClick={()=>setMobOpen(false)}/>}
<button className="mob-btn" onClick={()=>setMobOpen(!mobOpen)} style={{position:'fixed',top:8,left:8,zIndex:300,background:C.accent,color:'#fff',border:'none',borderRadius:6,width:36,height:36,cursor:'pointer',fontSize:20,display:'none'}}>&#9776;</button>
{sbHidden&&<button onClick={()=>setSbHidden(false)} title="Reafficher le menu" style={{position:'fixed',top:8,left:8,zIndex:300,background:C.accent,color:'#fff',border:'none',borderRadius:6,width:36,height:36,cursor:'pointer',fontSize:18,fontWeight:700,boxShadow:'0 2px 6px rgba(0,0,0,.3)'}}>&#9776;</button>}
<div className={'sb'+(mobOpen?' open':'')} style={{position:'fixed',top:0,left:0,width:160,height:'100vh',background:'#1e293b',padding:'16px 0',zIndex:200,overflowY:'auto',display:sbHidden?'none':'block'}}>
<div style={{padding:'8px 12px',marginBottom:8}}><img src="logo.png" alt="SONECO" style={{width:120,marginBottom:2}}/><div style={{fontSize:9,color:'#94a3b8',marginTop:2}}>RoadManager</div></div>
{pages.map(p=>(
<div key={p.k} onClick={()=>{setPg(p.k);setMobOpen(false)}} style={{padding:'8px 12px',cursor:'pointer',color:pg===p.k?'#fff':'#94a3b8',background:pg===p.k?'#334155':'transparent',fontSize:13,fontWeight:pg===p.k?700:400,display:'flex',alignItems:'center',gap:8}}>
<span dangerouslySetInnerHTML={{__html:p.i}}/>{p.l}
</div>))}
<div onClick={onUndo} style={{padding:'8px 12px',cursor:'pointer',color:'#fbbf24',fontSize:13,marginTop:16,borderTop:'1px solid #334155'}}>↩ Annuler</div>
<div onClick={onLogout} style={{padding:'8px 12px',cursor:'pointer',color:'#f87171',fontSize:13}}>Deconnexion</div>
</div>
<div className="main" style={{marginLeft:sbHidden?0:160,padding:20,minHeight:'100vh',background:C.bg}}>
{content()}
</div>
<AdminChatbot data={data} save={save}/>
</div>)};

// ======== CHATBOT IA ========
// Extrait un JSON de proposition d'action d'une reponse Claude.
// Claude doit envelopper l'action dans un bloc ```json {...} ``` avec un champ "action" parmi : send_message, create_job, update_job, delete_job, fix_time_entry.
const PROPOSAL_ACTIONS=['send_message','create_job','update_job','delete_job','fix_time_entry'];
const parseProposal=(text)=>{
if(!text)return null;
const m=text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
if(!m)return null;
try{
const obj=JSON.parse(m[1]);
if(!obj||!obj.action||!PROPOSAL_ACTIONS.includes(obj.action))return null;
if(obj.action==='send_message'&&(!obj.toEmpId||!obj.content))return null;
if(obj.action==='create_job'&&(!obj.data||typeof obj.data!=='object'))return null;
if(obj.action==='update_job'&&(!obj.jobId||!obj.changes||typeof obj.changes!=='object'))return null;
if(obj.action==='delete_job'&&!obj.jobId)return null;
if(obj.action==='fix_time_entry'&&(!obj.entryId||!obj.changes||typeof obj.changes!=='object'))return null;
const intro=text.slice(0,m.index).trim();
return{intro,proposal:obj};
}catch(e){}
return null;
};
const AdminChatbot=({data,save})=>{
const[open,setOpen]=useState(false);
const[msgs,setMsgs]=useState([]);
const[input,setInput]=useState('');
const[loading,setLoading]=useState(false);
const[listening,setListening]=useState(false);
const bottomRef=useRef(null);
const recRef=useRef(null);
useEffect(()=>{if(bottomRef.current)bottomRef.current.scrollIntoView({behavior:'smooth'})},[msgs,loading]);
const[voiceOut,setVoiceOut]=useState(()=>{try{return localStorage.getItem('rm-chat-voice')==='1'}catch(e){return false}});
useEffect(()=>{try{localStorage.setItem('rm-chat-voice',voiceOut?'1':'0')}catch(e){}},[voiceOut]);
const ttsSupported=typeof window!=='undefined'&&'speechSynthesis'in window;
const ttsUnlockedRef=useRef(false);
// iOS/Safari : la synthese vocale doit etre debloquee par une interaction utilisateur (click/tap).
// On appelle primeTTS() depuis un onClick (toggle ou send) pour forcer le deblocage.
const primeTTS=()=>{
if(!ttsSupported||ttsUnlockedRef.current)return;
try{
const u=new SpeechSynthesisUtterance(' ');
u.lang='fr-FR';u.volume=0;
window.speechSynthesis.speak(u);
ttsUnlockedRef.current=true;
}catch(e){}
};
const pickFrenchVoice=()=>{
if(!ttsSupported)return null;
const voices=window.speechSynthesis.getVoices()||[];
return voices.find(v=>v.lang&&v.lang.startsWith('fr'))||null;
};
useEffect(()=>{
if(!ttsSupported)return;
// Force le chargement des voix (iOS / certains Android renvoient [] avant cet event)
const h=()=>{};
window.speechSynthesis.onvoiceschanged=h;
try{window.speechSynthesis.getVoices()}catch(e){}
return()=>{try{window.speechSynthesis.onvoiceschanged=null}catch(e){}};
},[]);
const speak=(text)=>{
if(!ttsSupported||!text)return;
try{
window.speechSynthesis.cancel();
const clean=text.replace(/```[\s\S]*?```/g,'').replace(/[*_`#]/g,'').replace(/\s+/g,' ').trim();
if(!clean)return;
const u=new SpeechSynthesisUtterance(clean);
u.lang='fr-FR';u.rate=0.9;u.pitch=1;u.volume=1;
const fr=pickFrenchVoice();if(fr)u.voice=fr;
try{window.speechSynthesis.resume()}catch(e){}
window.speechSynthesis.speak(u);
}catch(e){console.warn('TTS error',e)}
};
const stopSpeaking=()=>{if(ttsSupported){try{window.speechSynthesis.cancel()}catch(e){}}};
useEffect(()=>{return()=>stopSpeaking()},[]);
const speechSupported=typeof window!=='undefined'&&(window.SpeechRecognition||window.webkitSpeechRecognition);
const toggleMic=()=>{
if(listening){if(recRef.current){try{recRef.current.stop()}catch(e){}}setListening(false);return}
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){alert('Reconnaissance vocale non supportee. Utilise Chrome ou Edge.');return}
try{
const rec=new SR();
rec.lang='fr-FR';
rec.continuous=false;
rec.interimResults=true;
let finalText='';
rec.onresult=(e)=>{
let interim='';
for(let i=e.resultIndex;i<e.results.length;i++){
const t=e.results[i][0].transcript;
if(e.results[i].isFinal)finalText+=t;else interim+=t;
}
setInput((finalText+interim).trim());
};
rec.onend=()=>{setListening(false);recRef.current=null};
rec.onerror=(e)=>{setListening(false);recRef.current=null;if(e.error==='not-allowed')alert('Microphone refuse. Autorise l\'acces au micro dans le navigateur.');else if(e.error!=='aborted'&&e.error!=='no-speech')console.warn('Erreur micro:',e.error)};
rec.start();
recRef.current=rec;
setListening(true);
}catch(e){alert('Erreur micro: '+e.message);setListening(false)}
};
const todayISO=fmtDateISO(new Date());
const buildCtx=()=>{
const employees=data.employees||[];
const machines=data.machines||[];
const trucks=data.trucks||[];
const cars=data.cars||[];
const depots=data.depots||[];
const clients=data.clients||[];
const forfaits=data.forfaits||{};
const allJobs=data.jobs||[];
const allTE=data.timeEntries||[];
const pannes=data.panneReports||[];
const interventions=data.interventions||[];
const maintenanceReqs=data.maintenanceRequests||[];
const parts=data.parts||[];
const messagesArr=data.messages||[];
// Helpers de noms
const empName=id=>{const e=employees.find(x=>x.id===id);return e?e.name:'?'};
const machName=id=>{const m=machines.find(x=>x.id===id);return m?m.name:'?'};
const truckName=id=>{const t=trucks.find(x=>x.id===id);return t?t.name:'?'};
const cliName=id=>{const c=clients.find(x=>x.id===id);return c?c.name:'?'};
const depotName=id=>{const d=depots.find(x=>x.id===id);return d?d.name:'?'};
// Fenetres temporelles
const past30=[];for(let i=30;i>=1;i--){const d=new Date();d.setDate(d.getDate()-i);past30.push(fmtDateISO(d))}
const future30=[];for(let i=0;i<30;i++){const d=new Date();d.setDate(d.getDate()+i);future30.push(fmtDateISO(d))}
const horizon60=[...past30,...future30];
const monDate=(()=>{const d=new Date();const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);const m=new Date(d);m.setDate(diff);return fmtDateISO(m)})();
const weekDates=[];for(let i=0;i<7;i++){const d=new Date(monDate);d.setDate(d.getDate()+i);weekDates.push(fmtDateISO(d))}
const monthStart=todayISO.slice(0,8)+'01';
const monthEnd=(()=>{const d=new Date();const e=new Date(d.getFullYear(),d.getMonth()+1,0);return fmtDateISO(e)})();
const lastMonthStart=(()=>{const d=new Date();const lm=new Date(d.getFullYear(),d.getMonth()-1,1);return fmtDateISO(lm)})();
const lastMonthEnd=(()=>{const d=new Date();const lme=new Date(d.getFullYear(),d.getMonth(),0);return fmtDateISO(lme)})();
const yearStart=data.yearStart||(new Date().getFullYear()+'-01-01');
// Jobs / TE filtres
const jobsHorizon=allJobs.filter(j=>horizon60.includes(j.date));
const jobsToday=jobsHorizon.filter(j=>j.date===todayISO&&j.type!=='depot');
const tolMin=data.toleranceMinutes!=null?data.toleranceMinutes:TOLERANCE_MINUTES;
const ot50=data.overtime50Threshold||43;
const ot25=data.overtime25Threshold||35;

let ctx=`Tu es l'assistant de RoadManager, logiciel de gestion de chantiers pour SONECO (rabotage routier).
Date du jour: ${todayISO} (${fmtDate(todayISO)}). Semaine en cours: lundi ${monDate}.
Tu as acces a TOUTES les donnees de l'app : referentiel, planning -30/+30j, pointages 30j passes, pannes, interventions, stock, messages, parametres, anomalies.\n`;
// Contexte entreprise libre saisi par l'admin dans Parametres > Assistant IA
if(data.companyContext&&data.companyContext.trim()){
ctx+=`\n=== CONTEXTE ENTREPRISE (regles metier specifiques a SONECO, ecrites par l'admin) ===\n${data.companyContext.trim()}\n=== FIN CONTEXTE ENTREPRISE ===\nUtilise ce contexte pour interpreter les donnees et adapter tes reponses aux habitudes de l'entreprise.\n`;
}

// === PARAMETRES ===
ctx+=`\n=== PARAMETRES ===\n`;
ctx+=`Carburant defaut: ${data.fuelPrice||1.72}€/L | Majoration nuit: +${data.nightPct||30}%\n`;
ctx+=`Tolerance pointage: ${tolMin}min | Temps en plus depart: ${data.tempsPlusDepart!=null?data.tempsPlusDepart:TEMPS_PLUS_DEPART}min | arrivee: ${data.tempsPlusArrivee!=null?data.tempsPlusArrivee:TEMPS_PLUS_ARRIVEE}min\n`;
ctx+=`Heures: ${data.weeklyHoursNormal||35}h/sem normal, supp 25%>${ot25}h, supp 50%>${ot50}h, ref jour ${data.refHoursPerDay||1}h\n`;
ctx+=`Repas: panier ${data.paniersPrice!=null?data.paniersPrice:12}€ | resto ${data.restoPrice!=null?data.restoPrice:15}€\n`;
ctx+=`Couts mensuels: loyer depot ${data.monthlyRent||0}€ | admin ${data.monthlyAdmin||0}€ | RC pro ${data.monthlyInsuranceRC||0}€ | jours ouvres/mois ${data.workDaysPerMonth||22}\n`;
ctx+=`Debut exercice fiscal: ${yearStart}\n`;

// === EMPLOYES ===
ctx+=`\n=== EMPLOYES (${employees.length}) — id | nom (utilise l'id pour envoyer des messages) ===\n`;
employees.forEach(e=>{
const sal=e.salaryType==='monthly'?`mens. ${e.monthlySalary||0}€`:`${e.hourlyRate||0}€/h`;
const tk=e.truckId?` cam:${truckName(e.truckId)}`:'';
const mc=e.machineId?` mach:${machName(e.machineId)}`:'';
ctx+=`  - ${e.id} | ${e.name}${e.role?' ['+e.role+']':''} | ${sal}${tk}${mc}\n`;
});

// === MACHINES ===
ctx+=`\n=== MACHINES (${machines.length}) ===\n`;
machines.forEach(m=>{ctx+=`  - ${m.id} | ${m.name} | ${m.type}${m.width?' '+m.width+'mm':''}\n`});

// === CAMIONS ===
if(trucks.length>0){ctx+=`\n=== CAMIONS (${trucks.length}) ===\n`;trucks.forEach(t=>{ctx+=`  - ${t.id} | ${t.name}${t.imm?' ('+t.imm+')':''}\n`})}

// === VOITURES ===
if(cars.length>0){ctx+=`\n=== VOITURES (${cars.length}) ===\n`;cars.forEach(c=>{ctx+=`  - ${c.id} | ${c.name}${c.imm?' ('+c.imm+')':''}\n`})}

// === DEPOTS ===
if(depots.length>0){ctx+=`\n=== DEPOTS (${depots.length}) ===\n`;depots.forEach(d=>{ctx+=`  - ${d.id} | ${d.name}${d.gnrPrice?' GNR:'+d.gnrPrice+'€':''}${d.gazolePrice?' Gaz:'+d.gazolePrice+'€':''}\n`})}

// === CLIENTS ===
ctx+=`\n=== CLIENTS (${clients.length}) ===\n`;
clients.forEach(c=>{const sm=(c.siteManagers||[]).length;ctx+=`  - ${c.id} | ${c.name}${c.forfaitType==='specific'?' [forfait specifique]':''}${sm>0?` | ${sm} chef(s) chantier`:''}\n`});

// === FORFAITS ===
const fkeys=Object.keys(forfaits);
if(fkeys.length>0){
ctx+=`\n=== FORFAITS (tarifs €) ===\n`;
fkeys.forEach(k=>{const v=forfaits[k];const items=[];Object.entries(v||{}).forEach(([dur,pr])=>{if(pr>0)items.push(`${dur}:${pr}`)});if(items.length)ctx+=`  - ${k}: ${items.join(', ')}\n`});
}

// === PLANNING -30 / +30 jours (compact) ===
ctx+=`\n=== PLANNING (chantiers, du ${past30[0]} au ${future30[future30.length-1]}) ===\n`;
// Helper: retrouve le rapport machine GPS pour un job (par nom de machine + date)
const machineReports=data.machineReports||[];
const mNorm=s=>String(s||'').toUpperCase().replace(/[\s\-_]/g,'');
const findMachineReport=(j)=>{
const mach=machines.find(m=>m.id===j.machineId);if(!mach)return null;
return machineReports.find(r=>mNorm(r.machineName)===mNorm(mach.name)&&r.date===j.date)||null;
};
const fmtJobLine=(j)=>{
const ca=(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0);
const te=allTE.find(t=>t.empId===j.employeeId&&t.date===j.date&&t.startTime);
const fh=forfaitHours(j.forfaitType);
const pauseM=te?(te.pauseMin||0):(fh>=6?60:0);
const theo=calcTheoreticalTimes(j,data,pauseM);
const pauseInfo=te&&te.pauseMin?` (pause ${te.pauseMin}min${te.breakStart&&te.breakEnd?' '+te.breakStart+'-'+te.breakEnd:''})`:(!te&&fh>=6?' (pause estimee 60min)':'');
const hStr=theo?` theo:${theo.theoStart}-${theo.theoEnd}${pauseInfo}`:(j.billingStart?' fact:'+j.billingStart:'');
let timeline='';
// Pour les jobs passes : ajoute la timeline GPS detaillee si disponible
if(j.date<=todayISO){
const mr=findMachineReport(j);
if(mr){
const evts=[];
if(mr.depotDepart)evts.push('dep_dep '+mr.depotDepart);
const site=(mr.sites&&mr.sites[0])||{};
if(site.siteArrival)evts.push('arr_chantier '+site.siteArrival);
if(site.workStart)evts.push('debut_fraisage '+site.workStart);
if(site.workEnd)evts.push('fin_fraisage '+site.workEnd);
if(site.siteDeparture)evts.push('dep_chantier '+site.siteDeparture);
if(mr.depotArrival)evts.push('arr_depot '+mr.depotArrival);
if(evts.length>0)timeline=' | TIMELINE: '+evts.join(' → ');
}
// Ajout du pointage du salarie (embauche/debauche reelles)
if(te&&te.startTime){
const realInfo=` reel:${te.startTime}-${te.endTime||'??'}`;
timeline=realInfo+timeline;
}
}
return `[${j.id}] ${empName(j.employeeId)} | ${machName(j.machineId)} | ${cliName(j.clientId)} | ${j.forfaitType||'?'} | ${ca.toFixed(0)}€${j.isNight?' nuit':''}${hStr}${timeline}`;
};
horizon60.forEach(d=>{
const djs=allJobs.filter(j=>j.date===d&&j.type!=='depot');
if(djs.length===0)return;
const lbl=d===todayISO?' [AUJ]':(d===future30[1]?' [DEMAIN]':'');
ctx+=`${d}${lbl}: `;djs.forEach((j,i)=>{ctx+=(i>0?' || ':'')+fmtJobLine(j)});ctx+='\n';
});

// === CA AGREGE ===
const caForJobs=js=>js.reduce((s,j)=>s+(j.priceForfait||0)+(j.hasTransfer?j.transferPrice||0:0),0);
const jobsWeek=allJobs.filter(j=>weekDates.includes(j.date)&&j.type!=='depot');
const jobsMonth=allJobs.filter(j=>j.date>=monthStart&&j.date<=monthEnd&&j.type!=='depot');
const jobsLastMonth=allJobs.filter(j=>j.date>=lastMonthStart&&j.date<=lastMonthEnd&&j.type!=='depot');
const jobsYear=allJobs.filter(j=>j.date>=yearStart&&j.date<=todayISO&&j.type!=='depot');
ctx+=`\n=== CA ===\nAUJ: ${caForJobs(jobsToday).toFixed(0)}€ (${jobsToday.length} jobs) | SEM: ${caForJobs(jobsWeek).toFixed(0)}€ (${jobsWeek.length}) | MOIS: ${caForJobs(jobsMonth).toFixed(0)}€ (${jobsMonth.length}) | MOIS-1: ${caForJobs(jobsLastMonth).toFixed(0)}€ (${jobsLastMonth.length}) | EXERCICE: ${caForJobs(jobsYear).toFixed(0)}€ (${jobsYear.length})\n`;

// Machines libres aujourd'hui
const freeToday=machines.filter(m=>!jobsToday.find(j=>j.machineId===m.id));
ctx+=`Machines libres aujourd'hui: ${freeToday.length>0?freeToday.map(m=>m.name).join(', '):'aucune'}\n`;

// === POINTAGES 30 derniers jours ===
const recentTE=allTE.filter(t=>past30.includes(t.date)||t.date===todayISO);
if(recentTE.length>0){
ctx+=`\n=== POINTAGES 30j (${recentTE.length} entrees) ===\n`;
const teByDate={};recentTE.forEach(t=>{(teByDate[t.date]=teByDate[t.date]||[]).push(t)});
Object.keys(teByDate).sort().reverse().slice(0,30).forEach(d=>{
ctx+=`${d}: `;
teByDate[d].forEach((t,i)=>{
if(t.type==='absence'){ctx+=(i>0?' | ':'')+`[${t.id}] ${empName(t.empId)}:ABS(${t.absenceType||'?'})`;return}
const hours=(t.startTime&&t.endTime)?(calcWorkedMin(t)/60):null;
ctx+=(i>0?' | ':'')+`[${t.id}] ${empName(t.empId)}:${t.startTime||'--'}-${t.endTime||'--'}${t.pauseMin?' p'+t.pauseMin+'m':''}${hours!==null?' ='+hours.toFixed(1)+'h':''}${t.mealType&&t.mealType!=='PANIER'?' ['+t.mealType+']':''}${t.nightHours?' nuit'+t.nightHours+'h':''}`;
});
ctx+='\n';
});
}

// === HEURES PAR SALARIE — semaine en cours ===
const empWeekMin={};
allTE.filter(t=>weekDates.includes(t.date)&&t.startTime&&t.endTime).forEach(t=>{
empWeekMin[t.empId]=(empWeekMin[t.empId]||0)+calcWorkedMin(t);
});
if(Object.keys(empWeekMin).length>0){
ctx+=`\n=== HEURES SEMAINE EN COURS (lundi ${monDate}) ===\n`;
Object.entries(empWeekMin).sort((a,b)=>b[1]-a[1]).forEach(([eid,min])=>{const h=min/60;const flag=h>ot50?' [SUPP 50%]':h>ot25?' [SUPP 25%]':'';ctx+=`  - ${empName(eid)}: ${h.toFixed(1)}h${flag}\n`});
}

// === HEURES PAR SALARIE — mois en cours ===
const empMonthMin={};
allTE.filter(t=>t.date>=monthStart&&t.date<=monthEnd&&t.startTime&&t.endTime).forEach(t=>{
empMonthMin[t.empId]=(empMonthMin[t.empId]||0)+calcWorkedMin(t);
});
if(Object.keys(empMonthMin).length>0){
ctx+=`\n=== HEURES MOIS EN COURS ===\n`;
Object.entries(empMonthMin).sort((a,b)=>b[1]-a[1]).forEach(([eid,min])=>{ctx+=`  - ${empName(eid)}: ${(min/60).toFixed(1)}h\n`});
}

// === PANNES OUVERTES ===
const openPannes=pannes.filter(p=>p.status!=='resolved'&&p.status!=='done');
if(openPannes.length>0){
ctx+=`\n=== PANNES OUVERTES (${openPannes.length}) ===\n`;
openPannes.slice(0,30).forEach(p=>{const eq=p.machineId?machName(p.machineId):p.truckId?truckName(p.truckId):p.carId?((cars.find(c=>c.id===p.carId)||{}).name||'?'):'?';ctx+=`  - ${p.date} | ${eq} | sev:${p.severity||'?'} | par:${empName(p.reportedBy)} | ${(p.description||'').slice(0,80)}\n`});
}

// === DEMANDES MAINTENANCE ===
const openMaint=maintenanceReqs.filter(m=>m.status!=='done'&&m.status!=='resolved');
if(openMaint.length>0){
ctx+=`\n=== DEMANDES MAINTENANCE (${openMaint.length}) ===\n`;
openMaint.slice(0,30).forEach(m=>{ctx+=`  - ${m.date} | ${machName(m.machineId)} | par:${empName(m.reportedBy)} | ${(m.description||'').slice(0,80)}\n`});
}

// === INTERVENTIONS 30j ===
const recentInter=interventions.filter(i=>past30.includes(i.date)||i.date===todayISO);
if(recentInter.length>0){
const totalC=recentInter.reduce((s,i)=>s+(i.totalCost||0),0);
ctx+=`\n=== INTERVENTIONS 30j (${recentInter.length}, cout total ${totalC.toFixed(0)}€) ===\n`;
recentInter.slice(0,25).forEach(i=>{const eq=i.machineId?machName(i.machineId):i.truckId?truckName(i.truckId):i.carId?((cars.find(c=>c.id===i.carId)||{}).name||'?'):'?';ctx+=`  - ${i.date} | ${eq} | ${i.type||'?'} | ${(i.totalCost||0).toFixed(0)}€ | ${(i.description||'').slice(0,60)}\n`});
if(recentInter.length>25)ctx+=`  ... et ${recentInter.length-25} autres\n`;
}

// === STOCK FAIBLE ===
const lowStock=parts.filter(p=>(p.quantity||0)<=2);
if(lowStock.length>0){
ctx+=`\n=== STOCK FAIBLE (${lowStock.length} pieces avec ≤2 en stock) ===\n`;
lowStock.slice(0,30).forEach(p=>{ctx+=`  - ${p.name||'?'}${p.category?' ['+p.category+']':''}: ${p.quantity||0} restant\n`});
}

// === MESSAGES RECENTS ENVOYES ===
const recentMsgs=messagesArr.slice(-10);
if(recentMsgs.length>0){
ctx+=`\n=== DERNIERS MESSAGES ENVOYES (${recentMsgs.length} sur ${messagesArr.length} total) ===\n`;
recentMsgs.forEach(m=>{ctx+=`  - ${m.date?m.date.slice(0,16):''} → ${empName(m.toEmpId)}: "${(m.content||'').slice(0,80)}"${m.read?' [lu]':' [non lu]'}\n`});
}

// === DETECTION D'ANOMALIES ===
const last7=[];for(let i=0;i<7;i++){const d=new Date();d.setDate(d.getDate()-i);last7.push(fmtDateISO(d))}
const past7=last7.filter(d=>d<todayISO);
const anom=[];
// 1. Pointages non termines (jours passes)
(data.timeEntries||[]).filter(t=>past7.includes(t.date)&&t.startTime&&!t.endTime&&t.type!=='absence'&&t.type!=='pending').forEach(t=>{
const emp=employees.find(e=>e.id===t.empId);
anom.push(`[Pointage non termine] ${emp?emp.name:'?'} le ${t.date} : debut ${t.startTime}, pas de fin enregistree`);
});
// 2. Journees > 14h (oubli de pointer la fin probable, sauf shift de nuit normal)
(data.timeEntries||[]).filter(t=>last7.includes(t.date)&&t.startTime&&t.endTime).forEach(t=>{
const min=calcWorkedMin(t);
if(min>840){const emp=employees.find(e=>e.id===t.empId);anom.push(`[Journee tres longue] ${emp?emp.name:'?'} le ${t.date} = ${(min/60).toFixed(1)}h (oubli de pointer la fin ?)`)}
});
// 3. Retards d'embauche vs theorique (jours passes)
(data.jobs||[]).filter(j=>past7.includes(j.date)&&j.employeeId).forEach(j=>{
const theo=calcTheoreticalTimes(j,data,0);if(!theo)return;
const te=(data.timeEntries||[]).find(t=>t.empId===j.employeeId&&t.date===j.date&&t.startTime);
if(!te)return;
const[ash,asm]=te.startTime.split(':').map(Number);const actualMin=ash*60+asm;const dS=actualMin-theo.theoStartMin;
if(dS>tolMin){const emp=employees.find(e=>e.id===j.employeeId);anom.push(`[Retard embauche] ${emp?emp.name:'?'} le ${j.date} : +${dS}min (theo ${theo.theoStart}, reel ${te.startTime})`)}
});
// 4. Depassement heures supp semaine en cours (reuse empWeekMin)
Object.entries(empWeekMin).forEach(([eid,min])=>{const h=min/60;if(h>ot50){const emp=employees.find(e=>e.id===eid);anom.push(`[Heures supp 50%] ${emp?emp.name:'?'} = ${h.toFixed(1)}h cette semaine (seuil ${ot50}h)`)}});
// 5. Chantiers a venir sans chauffeur / sans machine
jobsHorizon.filter(j=>j.date>=todayISO&&j.type!=='depot').forEach(j=>{
const cli=clients.find(c=>c.id===j.clientId);const cn=cli?cli.name:'?';
if(!j.employeeId)anom.push(`[Chantier sans chauffeur] ${j.date} chez ${cn}`);
if(!j.machineId)anom.push(`[Chantier sans machine] ${j.date} chez ${cn}`);
});
// 6. Conflits planning (meme employe 2x ou plus meme date, futur)
const seen={};
jobsHorizon.filter(j=>j.date>=todayISO&&j.employeeId&&j.type!=='depot').forEach(j=>{const k=j.employeeId+'|'+j.date;if(seen[k])seen[k].push(j);else seen[k]=[j]});
Object.entries(seen).forEach(([k,arr])=>{if(arr.length>1){const[eid,d]=k.split('|');const emp=employees.find(e=>e.id===eid);anom.push(`[Conflit chauffeur] ${emp?emp.name:'?'} a ${arr.length} chantiers le ${d}`)}});
// 7. Conflits machine (meme machine 2x meme date)
const seenM={};
jobsHorizon.filter(j=>j.date>=todayISO&&j.machineId&&j.type!=='depot').forEach(j=>{const k=j.machineId+'|'+j.date;if(seenM[k])seenM[k].push(j);else seenM[k]=[j]});
Object.entries(seenM).forEach(([k,arr])=>{if(arr.length>1){const[mid,d]=k.split('|');const m=machines.find(x=>x.id===mid);anom.push(`[Conflit machine] ${m?m.name:'?'} sur ${arr.length} chantiers le ${d}`)}});
if(anom.length>0){
ctx+=`\n=== ANOMALIES DETECTEES (${anom.length}) — a signaler quand l'admin demande "problemes/anomalies" ou quand c'est pertinent ===\n`;
anom.slice(0,40).forEach(a=>{ctx+='  - '+a+'\n'});
if(anom.length>40)ctx+=`  ... et ${anom.length-40} autres anomalies non listees\n`;
}else{ctx+='\n=== ANOMALIES: aucune detectee sur les 7 derniers jours ni sur le planning a venir ===\n';}
ctx+=`\n=== CE QUE TU PEUX FAIRE ===
1. REPONDRE A DES QUESTIONS en lecture seule sur les donnees (planning, CA, employes, machines, pointages, anomalies, etc.)
2. SIGNALER LES ANOMALIES proactivement ou sur demande
3. PROPOSER UNE ACTION via un bloc JSON. Actions disponibles : send_message, create_job, update_job, delete_job, fix_time_entry.

=== REGLE D'OR ===
Tu ne fais JAMAIS d'action toi-meme. Tu PROPOSES uniquement, sous forme d'un bloc JSON. L'admin clique sur "Valider" pour declencher l'action. Si tu ne peux pas formuler une proposition propre (donnee manquante, ambiguite), demande une clarification au lieu de generer un JSON incomplet ou hasardeux. Ne JAMAIS dire "c'est fait" ou "je l'ai cree" — dis "je te propose...".

=== FORMAT GENERAL D'UNE PROPOSITION ===
Reponds avec une courte phrase d'intro + UN bloc JSON. Format :
\`\`\`json
{"action":"<nom>", ...}
\`\`\`
Tu peux aussi proposer plusieurs actions en sequence (ex: 2 chantiers a creer) en envoyant plusieurs reponses successives, mais UN SEUL bloc JSON par message.

=== ACTION 1 : send_message ===
Pour envoyer un message a un salarie.
\`\`\`json
{"action":"send_message","toEmpId":"<id>","content":"<texte au salarie, comme s'il le lisait>"}
\`\`\`

=== ACTION 2 : create_job ===
Pour creer un nouveau chantier. Champ "data" contient les attributs du chantier.
\`\`\`json
{"action":"create_job","data":{"date":"YYYY-MM-DD","employeeId":"<id>","machineId":"<id>","clientId":"<id>","billingStart":"HH:MM","forfaitType":"<2h|4h|6h|8h|Demi-journee|Journee|Transfert>","isNight":false}}
\`\`\`
Champs OBLIGATOIRES : date, employeeId, machineId, clientId, billingStart, forfaitType.
Champs optionnels : isNight (def false), siteManager, siteManagerPhone, travelMinAller, travelMinRetour, startFrom, endAt, hasTransfer, transferPrice, citOpt (pour citerne).
Le prix priceForfait sera calcule automatiquement par l'app a partir du forfait, machine, client.
Si une info manque (ex: pas de billingStart precise), utilise des defauts raisonnables (08:00) ET mentionne-le dans ton intro.

=== ACTION 3 : update_job ===
Pour modifier un chantier existant. Tu dois utiliser l'ID exact tire du PLANNING (format [job_xxx] visible avant chaque ligne).
\`\`\`json
{"action":"update_job","jobId":"<id_existant>","changes":{"<champ>":"<nouvelle_valeur>", ...}}
\`\`\`
Inclus uniquement les champs a modifier dans "changes". Ex: {"date":"2026-05-10"} pour decaler.
Avant de proposer, verifie que jobId existe dans le planning ci-dessus.

=== ACTION 4 : delete_job ===
Pour supprimer un chantier.
\`\`\`json
{"action":"delete_job","jobId":"<id_existant>"}
\`\`\`
Avant de proposer, verifie que jobId existe.

=== ACTION 5 : fix_time_entry ===
Pour corriger un pointage. ID visible avant chaque pointage dans la section POINTAGES (format [te_xxx] ou [autre_id]).
\`\`\`json
{"action":"fix_time_entry","entryId":"<id_existant>","changes":{"startTime":"HH:MM","endTime":"HH:MM","pauseMin":60, ...}}
\`\`\`
Champs modifiables : startTime, endTime, pauseMin, breakStart, breakEnd, mealType, absenceType, nightHours, requestedEndTime.

=== REGLES COMMUNES ===
- IDs : copie-colle EXACT depuis les sections de donnees ci-dessus. Pas d'inventions.
- Ambiguite : si plusieurs employes/jobs/pointages correspondent, demande une clarification au lieu de deviner.
- Donnees manquantes : utilise un defaut raisonnable ET signale-le, ou demande l'info.
- Un SEUL bloc JSON par reponse.
- Ne JAMAIS inventer une action accomplie. Tu PROPOSES, l'admin VALIDE.

=== COMPRENDRE LES DONNEES — TRES IMPORTANT ===
Avant de signaler une anomalie, COMPRENDS bien ces concepts metier :

1. FORFAIT ≠ DUREE DE TRAVAIL
   Le forfait (2h, 4h, 6h, 8h, Demi-journee, Journee, Transfert) est la duree FACTUREE au client, pas la duree reelle de travail. Un forfait 4h ne veut PAS dire que le chauffeur travaille 4h. Il facture 4h.

2. HEURES POINTEES = HEURES PAYEES AU SALARIE
   Les heures pointees (startTime/endTime moins pause) incluent : trajet aller, preparation, mise en place, le forfait lui-meme, repli, trajet retour, marges (tempsPlusDepart 25min + tempsPlusArrivee 30min par defaut). C'est normal et attendu que les heures pointees > duree forfait. Ne JAMAIS calculer "heures pointees - duree forfait = heures non facturees", c'est une comparaison qui n'a aucun sens metier.

3. EMBAUCHE/DEBAUCHE THEORIQUES = BASE DE COMPARAISON CORRECTE
   Pour chaque chantier, le planning te donne "embauche theo" et "debauche theo" (ex: "06:48-14:16"). Ces heures INCLUENT DEJA toutes les marges (trajet + tempsPlusDepart + forfait + pause + trajet retour + tempsPlusArrivee). C'est CES heures qu'il faut comparer au pointage reel pour detecter une anomalie.
   IMPORTANT : la debauche theorique est calculee avec la PAUSE REELLE prise par le salarie (lue depuis son pointage du jour). Pour les chantiers futurs sans pointage, une pause estimee de 60min est utilisee pour les forfaits >= 6h, sinon 0min — ce sera indique entre parentheses (ex: "06:48-14:16 (pause estimee 60min)"). Quand tu compares pointage vs theorique, ces heures sont DEJA ajustees a la pause reelle.

4. TIMELINE GPS DETAILLEE — UTILISE-LA QUAND DISPONIBLE
   Pour les jobs passes, si tu vois un champ "TIMELINE" sur la ligne du job, il contient les jalons GPS reels :
   - dep_dep = depart du depot (heure)
   - arr_chantier = arrivee sur le chantier
   - debut_fraisage = mise en route de la machine
   - fin_fraisage = arret de la machine (chantier termine)
   - dep_chantier = depart du chantier
   - arr_depot = retour au depot
   Et "reel:HH:MM-HH:MM" = embauche-debauche pointees par le salarie.
   La VRAIE analyse compare ces jalons. Exemple : si "arr_depot 11:17" mais "reel:...-15:27", il y a 4h10 entre retour depot et debauche pointee — dont la pause justifie 1h55, le reste (~2h15) est du temps non explique au depot (entretien? attente? autre tache?).

5. COMMENT REPERER UNE VRAIE ANOMALIE :
   - Compare reel vs theo (debauche surtout) en utilisant la timeline GPS si dispo.
   - Si arr_depot tres en avance vs debauche reelle = temps mort au depot a expliquer.
   - Si reel embauche differe de theo > tolerance = retard/avance suspecte.
   - Si pointage absent alors qu'il y a un chantier = absence non justifiee.

6. EXEMPLE CORRECT : "Franck a fini son chantier arev tot (retour depot 11:17 vs prevu 14:16) mais a clocke out a 15:27, soit ~2h15 au depot apres pause — entretien machine ou autre activite ?"
   EXEMPLE FAUX : "Forfait 4h mais 7h pointees, donc 3h non facturees" — comparaison qui n'a aucun sens metier.

=== REQUETES DE DISPONIBILITE — IMPORTANT ===
Quand l'admin demande une dispo (ex: "qui est dispo le 15 mai en raboteuse", "j'ai besoin d'une raboteuse vendredi", "dispo balayeuse demain", "Romain est libre lundi ?"), tu dois :

1. RESOUDRE LA DATE : convertis "demain", "vendredi", "la semaine prochaine" en date YYYY-MM-DD precise (utilise la date du jour en haut du contexte). Si la date est ambigue (ex: "vendredi" sans semaine), prends le prochain vendredi a venir et signale-le.

2. PARSER LE TYPE de machine demande (Raboteuse, Balayeuse, Citerne). Pour Raboteuse, l'admin peut preciser une largeur (ex: "raboteuse 1m" = width 1000mm, "petite raboteuse" = plus petite largeur). Si non specifie, prends toutes les Raboteuses.

3. CHERCHER LES MACHINES LIBRES de ce type ce jour-la :
   - Filtre les machines (data.machines) sur le type demande (et width si precisee)
   - Pour chaque machine, regarde si elle est sur un chantier ce jour (data.jobs avec j.machineId === m.id et j.date === la_date)
   - Une machine est LIBRE si aucun job n'utilise son ID ce jour-la

4. CROISER AVEC LE CHAUFFEUR :
   - Pour chaque machine libre, regarde s'il y a un chauffeur attitre (employe avec e.machineId === m.id, ou regle dans le contexte entreprise)
   - Verifie si ce chauffeur est libre ce jour (pas de job avec j.employeeId === e.id)
   - Si le chauffeur est en absence (timeEntry type=absence ce jour), signale-le
   - Si le chauffeur est sur un autre chantier ce jour, signale-le

5. REPONSE COURTE ET CLAIRE, format type :
   "Le 15 mai (vendredi), dispo en raboteuse : 130fi (Romain libre) et 80fi (sans chauffeur attitre). La 100fi est sur LABTP avec Franck."

   OU si rien de dispo :
   "Le 15 mai, toutes les raboteuses sont prises (130fi sur LABTP, 100fi sur STPA, 80fi sur arev). Veux-tu que je regarde un autre jour ?"

6. CAS PARTICULIERS :
   - Si l'admin demande la dispo d'un CHAUFFEUR (ex: "Romain est libre lundi ?"), regarde ses jobs ce jour + ses pointages d'absence. Reponds court : "Oui, libre" ou "Non, sur LABTP a 8h".
   - Si l'admin demande pour PLUSIEURS jours d'affilee ("dispo lundi-mercredi"), liste jour par jour.
   - Si le type de machine demande n'existe pas dans le parc, dis-le franchement.

=== TON & STYLE — TRES IMPORTANT ===
Tu parles a un patron de PME qui veut une reponse de COLLEGUE, pas un rapport de consultant.
- Reponses COURTES : 1 a 3 phrases maximum sauf si on te demande explicitement un detail/rapport.
- AUCUN tableau markdown (pas de | ou ---).
- AUCUN titre markdown (pas de # ou ##).
- AUCUN separateur (--- ou ***).
- Pas d'emoji decoratif sauf pour signaler une vraie alerte (max 1 par reponse).
- Style CONVERSATIONNEL, comme si tu repondais a l'oral. Ex: "Oui, Franck a 7h pointees mais le forfait est de 4h — il a fait 3h de rab non facturees. Tu veux que je verifie s'il a un autre chantier ?" plutot qu'un tableau structure.
- Tu peux utiliser des tirets simples - en debut de ligne pour 2-3 points si vraiment necessaire.
- Pas de "**gras**" markdown abusif.
- Si tu detectes un probleme : dis-le en 1 phrase + propose une action ou une question, point.
- N'invite PAS a l'action systematiquement ("Veux-tu que..." est OK 1 fois sur 3 max).
- Si l'admin pose une question simple ("qui travaille demain"), reponse en 1-2 lignes max.

Reponds toujours en francais.`;
return ctx;
};
const validateProposal=(msgIdx)=>{
const m=msgs[msgIdx];if(!m||!m.proposal)return;
const p=m.proposal;
const nd=JSON.parse(JSON.stringify(data));
let resultText='';
try{
if(p.action==='send_message'){
if(!nd.messages)nd.messages=[];
nd.messages.push({id:'msg_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),toEmpId:p.toEmpId,content:p.content,date:new Date().toISOString(),read:false,from:'admin'});
resultText=`Message envoye a ${(nd.employees||[]).find(e=>e.id===p.toEmpId)?.name||p.toEmpId}`;
}
else if(p.action==='create_job'){
if(!nd.jobs)nd.jobs=[];
const d=p.data||{};
const newJob={id:'job_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),...d};
// Calcul automatique du prix forfait si absent
if(newJob.priceForfait==null||newJob.priceForfait===0){
const mach=(nd.machines||[]).find(x=>x.id===newJob.machineId);
if(mach&&newJob.clientId&&newJob.forfaitType){
try{newJob.priceForfait=getForfaitPrice(nd,newJob.clientId,mach,newJob.forfaitType,newJob.citOpt,newJob.isNight)}catch(e){newJob.priceForfait=0}
}
}
// Calcul prix transfert si demande
if(newJob.hasTransfer&&(newJob.transferPrice==null||newJob.transferPrice===0)){
const mach=(nd.machines||[]).find(x=>x.id===newJob.machineId);
if(mach&&newJob.clientId){try{newJob.transferPrice=getTransferPrice(nd,newJob.clientId,mach,newJob.citOpt,newJob.isNight)}catch(e){newJob.transferPrice=0}}
}
nd.jobs.push(newJob);
const empN=(nd.employees||[]).find(e=>e.id===newJob.employeeId)?.name||'?';
const machN=(nd.machines||[]).find(mc=>mc.id===newJob.machineId)?.name||'?';
resultText=`Chantier cree: ${empN} | ${machN} | ${newJob.date}`;
}
else if(p.action==='update_job'){
const jIdx=(nd.jobs||[]).findIndex(j=>j.id===p.jobId);
if(jIdx<0){alert('Chantier introuvable: '+p.jobId);return}
nd.jobs[jIdx]={...nd.jobs[jIdx],...p.changes};
resultText=`Chantier modifie (${Object.keys(p.changes).length} champ(s))`;
}
else if(p.action==='delete_job'){
const dIdx=(nd.jobs||[]).findIndex(j=>j.id===p.jobId);
if(dIdx<0){alert('Chantier introuvable: '+p.jobId);return}
nd.jobs.splice(dIdx,1);
resultText='Chantier supprime';
}
else if(p.action==='fix_time_entry'){
const tIdx=(nd.timeEntries||[]).findIndex(t=>t.id===p.entryId);
if(tIdx<0){alert('Pointage introuvable: '+p.entryId);return}
nd.timeEntries[tIdx]={...nd.timeEntries[tIdx],...p.changes};
resultText=`Pointage corrige (${Object.keys(p.changes).length} champ(s))`;
}
}catch(e){alert('Erreur: '+e.message);return}
save(nd);
setMsgs(prev=>prev.map((x,i)=>i===msgIdx?{...x,proposalStatus:'sent',resultText}:x));
};
const cancelProposal=(msgIdx)=>{setMsgs(prev=>prev.map((x,i)=>i===msgIdx?{...x,proposalStatus:'cancelled'}:x))};
const editProposal=(msgIdx,newContent)=>{setMsgs(prev=>prev.map((x,i)=>i===msgIdx?{...x,proposal:{...x.proposal,content:newContent}}:x))};
const send=async()=>{
if(!input.trim()||loading)return;
const key=data.anthropicApiKey;
if(!key){alert('Clé API Claude manquante.\nVa dans Paramètres > Assistant IA pour la renseigner.');return;}
// iOS Safari : on profite du user gesture (clic sur ➤ ou Enter) pour debloquer la voix
if(voiceOut)primeTTS();
const userMsg={role:'user',content:input.trim()};
const newMsgs=[...msgs,userMsg];
setMsgs(newMsgs);setInput('');setLoading(true);
// On n'envoie que role/content a l'API (pas les champs proposal/proposalStatus internes)
const apiMsgs=newMsgs.map(m=>({role:m.role,content:m.content}));
try{
const resp=await fetch('https://api.anthropic.com/v1/messages',{
method:'POST',
headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1024,system:buildCtx(),messages:apiMsgs})
});
const d=await resp.json();
if(d.content&&d.content[0]&&d.content[0].text){
const txt=d.content[0].text;
const prop=parseProposal(txt);
if(prop){
const introTxt=prop.intro||'Voici le message a envoyer :';
setMsgs([...newMsgs,{role:'assistant',content:introTxt,proposal:prop.proposal,proposalStatus:'pending'}]);
if(voiceOut)speak(introTxt);
}else{
setMsgs([...newMsgs,{role:'assistant',content:txt}]);
if(voiceOut)speak(txt);
}
}else{
setMsgs([...newMsgs,{role:'assistant',content:'Erreur: '+(d.error?.message||JSON.stringify(d))}]);
}
}catch(e){
setMsgs([...newMsgs,{role:'assistant',content:'Erreur de connexion: '+e.message}]);
}
setLoading(false);
};
const examples=['Qui travaille aujourd\'hui ?','Quel est le CA du jour ?','Dis au premier salarie de la liste de passer me voir','Résume la journée'];
const getEmpName=(id)=>{const e=(data.employees||[]).find(x=>x.id===id);return e?e.name:id};
return(
<div style={{position:'fixed',bottom:20,right:20,zIndex:1000}}>
{open&&(
<div style={{position:'absolute',bottom:64,right:0,width:360,height:500,background:'#fff',borderRadius:16,boxShadow:'0 8px 40px rgba(0,0,0,0.18)',border:'1px solid '+C.border,display:'flex',flexDirection:'column',overflow:'hidden'}}>
<div style={{background:C.accent,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
<div style={{color:'#fff',fontWeight:700,fontSize:14}}>🤖 Assistant RoadManager</div>
<div style={{display:'flex',gap:6,alignItems:'center'}}>
{ttsSupported&&(<button onClick={()=>{if(voiceOut){stopSpeaking();setVoiceOut(false)}else{primeTTS();speak('Voix activee');setVoiceOut(true)}}} title={voiceOut?'Couper la voix':'Activer la voix'} style={{background:voiceOut?'#fff3':'transparent',border:'none',color:'#fff',fontSize:16,cursor:'pointer',padding:'2px 6px',borderRadius:6}}>{voiceOut?'🔊':'🔇'}</button>)}
<button onClick={()=>{stopSpeaking();setOpen(false);setMsgs([])}} style={{background:'none',border:'none',color:'#fff',fontSize:22,cursor:'pointer',lineHeight:1,padding:'0 2px'}}>×</button>
</div>
</div>
<div style={{flex:1,overflowY:'auto',padding:10,display:'flex',flexDirection:'column',gap:8}}>
{msgs.length===0&&(
<div style={{color:C.muted,fontSize:12,textAlign:'center',marginTop:12}}>
<div style={{fontSize:22,marginBottom:6}}>💬</div>
<div style={{marginBottom:10,color:C.dim}}>Posez une question ou demandez d'envoyer un message a un salarie !</div>
<div style={{display:'flex',flexDirection:'column',gap:4}}>
{examples.map(ex=>(
<button key={ex} onClick={()=>{setInput(ex)}} style={{background:'#f1f5f9',border:'1px solid '+C.border,borderRadius:8,padding:'5px 10px',fontSize:11,cursor:'pointer',color:C.text,textAlign:'left'}}>{ex}</button>
))}
</div>
</div>
)}
{msgs.map((m,i)=>(
<div key={i} style={{display:'flex',flexDirection:'column',alignItems:m.role==='user'?'flex-end':'flex-start',gap:6}}>
<div style={{maxWidth:'85%',padding:'7px 11px',borderRadius:10,background:m.role==='user'?C.accent:'#f1f5f9',color:m.role==='user'?'#fff':C.text,fontSize:12,lineHeight:1.5,whiteSpace:'pre-wrap'}}>
{m.content}
</div>
{m.proposal&&(()=>{
const p=m.proposal;
const accent=p.action==='delete_job'?(C.red||'#ef4444'):C.accent;
const headers={send_message:'📨 Message a '+getEmpName(p.toEmpId),create_job:'🆕 Creation chantier',update_job:'✏️ Modification chantier',delete_job:'🗑️ Suppression chantier',fix_time_entry:'⏱️ Correction pointage'};
const verbs={send_message:'Envoyer',create_job:'Creer',update_job:'Modifier',delete_job:'Supprimer',fix_time_entry:'Corriger'};
const findJob=jid=>(data.jobs||[]).find(j=>j.id===jid);
const findTE=tid=>(data.timeEntries||[]).find(t=>t.id===tid);
const fmtJobSummary=(j)=>j?`${getEmpName(j.employeeId)} | ${(data.machines||[]).find(m=>m.id===j.machineId)?.name||'?'} | ${(data.clients||[]).find(c=>c.id===j.clientId)?.name||'?'} | ${j.date} ${j.billingStart||''} | ${j.forfaitType||'?'}`:'(introuvable)';
return(
<div style={{width:'95%',border:'1.5px solid '+accent,borderRadius:10,background:'#fff',padding:10,fontSize:12}}>
<div style={{fontWeight:700,color:accent,marginBottom:6}}>{headers[p.action]||p.action}</div>
{p.action==='send_message'&&m.proposalStatus==='pending'&&(
<textarea value={p.content} onChange={e=>editProposal(i,e.target.value)} rows={3} style={{width:'100%',padding:6,borderRadius:6,border:'1px solid '+C.border,fontSize:12,fontFamily:'inherit',resize:'vertical',marginBottom:6,outline:'none'}}/>
)}
{p.action==='create_job'&&(()=>{const d=p.data||{};const empN=getEmpName(d.employeeId);const machN=(data.machines||[]).find(mc=>mc.id===d.machineId)?.name||d.machineId;const cliN=(data.clients||[]).find(cl=>cl.id===d.clientId)?.name||d.clientId;return(
<div style={{fontSize:12,lineHeight:1.6,marginBottom:6}}>
<div><b>Date :</b> {d.date||'?'}{d.isNight?' (nuit)':''}</div>
<div><b>Chauffeur :</b> {empN}</div>
<div><b>Machine :</b> {machN}</div>
<div><b>Client :</b> {cliN}</div>
<div><b>Heure facturation :</b> {d.billingStart||'?'}</div>
<div><b>Forfait :</b> {d.forfaitType||'?'}</div>
{d.siteManager&&<div><b>Chef chantier :</b> {d.siteManager}{d.siteManagerPhone?' ('+d.siteManagerPhone+')':''}</div>}
{d.hasTransfer&&<div><b>Transfert :</b> oui{d.transferPrice?' ('+d.transferPrice+'€)':''}</div>}
</div>
)})()}
{p.action==='update_job'&&(()=>{const j=findJob(p.jobId);return(
<div style={{fontSize:12,lineHeight:1.6,marginBottom:6}}>
<div style={{color:C.muted,marginBottom:4}}>{fmtJobSummary(j)}</div>
{j&&Object.entries(p.changes||{}).map(([k,v])=>(<div key={k}><b>{k} :</b> <span style={{color:C.red||'#ef4444',textDecoration:'line-through'}}>{String(j[k]??'(vide)')}</span> → <span style={{color:C.green||'#16a34a',fontWeight:600}}>{String(v)}</span></div>))}
{!j&&<div style={{color:C.red}}>⚠ Chantier introuvable (id: {p.jobId})</div>}
</div>
)})()}
{p.action==='delete_job'&&(()=>{const j=findJob(p.jobId);return(
<div style={{fontSize:12,lineHeight:1.6,marginBottom:6}}>
{j?<div>{fmtJobSummary(j)}<div style={{color:C.red,marginTop:4,fontWeight:600}}>⚠ Cette suppression est definitive (mais Annuler dans le menu admin reste possible).</div></div>:<div style={{color:C.red}}>⚠ Chantier introuvable (id: {p.jobId})</div>}
</div>
)})()}
{p.action==='fix_time_entry'&&(()=>{const t=findTE(p.entryId);return(
<div style={{fontSize:12,lineHeight:1.6,marginBottom:6}}>
{t?<div style={{color:C.muted,marginBottom:4}}>{getEmpName(t.empId)} — {t.date} — actuel : {t.startTime||'--'}-{t.endTime||'--'} pause {t.pauseMin||0}min</div>:<div style={{color:C.red}}>⚠ Pointage introuvable (id: {p.entryId})</div>}
{t&&Object.entries(p.changes||{}).map(([k,v])=>(<div key={k}><b>{k} :</b> <span style={{color:C.red||'#ef4444',textDecoration:'line-through'}}>{String(t[k]??'(vide)')}</span> → <span style={{color:C.green||'#16a34a',fontWeight:600}}>{String(v)}</span></div>))}
</div>
)})()}
{m.proposalStatus==='pending'&&(
<div style={{display:'flex',gap:6}}>
<button onClick={()=>validateProposal(i)} style={{flex:1,background:p.action==='delete_job'?(C.red||'#ef4444'):(C.green||'#16a34a'),color:'#fff',border:'none',borderRadius:6,padding:'6px 10px',cursor:'pointer',fontWeight:700,fontSize:12}}>✓ {verbs[p.action]||'Valider'}</button>
<button onClick={()=>cancelProposal(i)} style={{flex:1,background:'#f1f5f9',color:C.text,border:'1px solid '+C.border,borderRadius:6,padding:'6px 10px',cursor:'pointer',fontWeight:600,fontSize:12}}>✕ Annuler</button>
</div>
)}
{m.proposalStatus==='sent'&&(<div style={{color:C.green||'#16a34a',fontWeight:600,fontSize:12}}>✓ {m.resultText||'Action validee'}</div>)}
{m.proposalStatus==='cancelled'&&(<div style={{color:C.muted,fontStyle:'italic',fontSize:12}}>✕ Annule</div>)}
</div>
)})()}
</div>
))}
{loading&&<div style={{display:'flex',justifyContent:'flex-start'}}><div style={{background:'#f1f5f9',borderRadius:10,padding:'7px 14px',fontSize:20,color:C.muted}}>...</div></div>}
<div ref={bottomRef}/>
</div>
<div style={{padding:'8px',borderTop:'1px solid '+C.border,display:'flex',gap:6,flexShrink:0,alignItems:'center'}}>
<input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&send()} placeholder={listening?'🎤 Parle...':'Votre question...'} style={{flex:1,padding:'7px 10px',borderRadius:8,border:'1px solid '+(listening?'#ef4444':C.border),fontSize:12,outline:'none',background:listening?'#fef2f2':'#fff'}}/>
{speechSupported&&(
<button onClick={toggleMic} title={listening?'Stop':'Dicter'} style={{background:listening?'#ef4444':'#f1f5f9',color:listening?'#fff':C.text,border:'1px solid '+(listening?'#ef4444':C.border),borderRadius:8,padding:'7px 10px',cursor:'pointer',fontSize:14,transition:'all .2s'}}>{listening?'⏹':'🎤'}</button>
)}
<button onClick={send} disabled={loading||!input.trim()} style={{background:C.accent,color:'#fff',border:'none',borderRadius:8,padding:'7px 12px',cursor:'pointer',fontWeight:700,fontSize:14,opacity:loading||!input.trim()?0.45:1,transition:'opacity .2s'}}>➤</button>
</div>
</div>
)}
<button onClick={()=>setOpen(o=>!o)} title="Assistant IA" style={{width:50,height:50,borderRadius:'50%',background:C.accent,color:'#fff',border:'none',fontSize:20,cursor:'pointer',boxShadow:'0 4px 16px rgba(0,0,0,0.2)',display:'flex',alignItems:'center',justifyContent:'center',transition:'transform .2s',transform:open?'rotate(45deg)':'none'}}>
{open?'×':'💬'}
</button>
</div>
);};

// ======== APP ROOT ========
const App=()=>{
const savedSession=(()=>{try{const s=localStorage.getItem('rm-session');return s?JSON.parse(s):null}catch(e){return null}})();
const[screen,setScreen]=useState(savedSession?savedSession.screen:'login');const[data,setData]=useState(null);const[empId,setEmpId]=useState(savedSession?savedSession.empId:null);
const savingRef=useRef(false);
const undoStack=useRef([]);
const dataRef=useRef(data);
useEffect(()=>{dataRef.current=data},[data]);
useEffect(()=>{try{localStorage.setItem('rm-session',JSON.stringify({screen,empId}))}catch(e){}},[screen,empId]);
useEffect(()=>{
// Charge le blob app_data, puis fusionne/migre les pointages depuis time_entries / time_entries_validated
loadData().then(async d=>{const migrated=await teMigrateFromBlob(d);setData(migrated)});
// Subscribe blob changes (machines, employes, missions, etc.) — comportement existant
const unsub=subscribeToChanges((nd)=>{if(!savingRef.current)setData(nd)},()=>dataRef.current);
// Subscribe aux tables dediees pointage : toute modif d'un autre client met a jour la vue
const unsubTE=teSubscribe(async(table)=>{if(savingRef.current)return;const key=table==='time_entries_validated'?'timeEntriesValidated':'timeEntries';const list=await teLoadAll(table);if(list===null)return;setData(prev=>prev?{...prev,[key]:list}:prev)});
// Flush les pointages en attente (si reseau coupe au precedent usage, ils partent maintenant)
teQueueFlush().catch(()=>{});
// Polling fallback toutes les 30s : si le realtime Supabase n'est pas actif, on rattrape ici
const pollId=setInterval(()=>{if(savingRef.current)return;loadData().then(d=>{if(!d)return;setData(prev=>{if(!prev)return d;const merged={...d};merged.timeEntries=mergeArraysById(prev.timeEntries,d.timeEntries);merged.panneReports=mergeArraysById(prev.panneReports,d.panneReports);return merged})}).catch(()=>{})},30000);
return()=>{unsub();unsubTE();clearInterval(pollId)};
},[]);
const doSave=useCallback(async nd=>{savingRef.current=true;undoStack.current=[...(undoStack.current||[]).slice(-19),JSON.stringify(data)];setData(nd);await teSyncChanges(data,nd);await saveData(nd);setTimeout(()=>{savingRef.current=false},2000)},[data]);
const doUndo=useCallback(async()=>{if(!undoStack.current||undoStack.current.length===0){alert('Rien a annuler');return}const prev=undoStack.current.pop();const prevData=JSON.parse(prev);savingRef.current=true;setData(prevData);await saveData(prevData);setTimeout(()=>{savingRef.current=false},2000)},[]);
const onLogin=(type,eid)=>{if(type==='admin'){setScreen('admin')}else{const emp=(data.employees||[]).find(e=>e.id===eid);setScreen(emp&&emp.role==='mechanic'?'mechanic':'employee')}if(eid)setEmpId(eid)};
const onLogout=()=>{setScreen('login');setEmpId(null);try{localStorage.removeItem('rm-session')}catch(e){}};
if(!data)return(<div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh'}}><div style={{fontSize:48}}>&#128679;</div></div>);
if(screen==='login')return(<LoginScreen data={data} onLogin={onLogin}/>);
if(screen==='mechanic')return(<MechanicView data={data} save={doSave} empId={empId} onLogout={onLogout}/>);
if(screen==='employee')return(<EmployeeView data={data} save={doSave} empId={empId} onLogout={onLogout}/>);
return(<AdminPanel data={data} save={doSave} onLogout={onLogout} onUndo={doUndo}/>);
};

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
