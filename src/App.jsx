import { useState, useEffect, useRef, useCallback } from "react";

// ─── constants & helpers ────────────────────────────────────────────────────
const toKey = (d) => d.toISOString().slice(0, 10);
const todayDate = () => new Date();
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const uid    = () => Math.random().toString(36).slice(2,9);

const EMPTY_DAY = () => ({
  notes:"", summary:"", summaryGenerated:false,
  actions:[],   // { id, text, status:"pending"|"complete"|"incomplete", dueTime:"" }
  reflection:{ missed:"", improve:"", wins:"" },
});

// ─── persistence ─────────────────────────────────────────────────────────────
function useStore() {
  const [data, setData] = useState(() => {
    try { return JSON.parse(localStorage.getItem("dcc_v2")||"{}"); } catch{ return {}; }
  });
  const save = (next) => { setData(next); localStorage.setItem("dcc_v2", JSON.stringify(next)); };
  const getDay = (key) => data[key] || EMPTY_DAY();
  const patchDay = (key, patch) => save({ ...data, [key]: { ...getDay(key), ...patch } });
  return { data, getDay, patchDay };
}

// ─── AI helper ────────────────────────────────────────────────────────────────
async function callClaude(system, user, json=false) {
  const res = await fetch("/api/claude", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ system, user, max_tokens:1200 })
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  const text = d.text || "";
  if (!json) return text;
  try { return JSON.parse(text.replace(/```json|```/g,"").trim()); } catch{ return null; }
}

// ─── FREE fallbacks (work without any API key) ───────────────────────────────
function localSummary(day) {
  const total = day.actions.length;
  const done = day.actions.filter(a=>a.status==="complete");
  const missed = day.actions.filter(a=>a.status==="incomplete");
  const parts = [];
  if (total > 0) {
    parts.push(`Completed ${done.length} of ${total} task${total>1?"s":""} today (${Math.round(done.length/total*100)}%).`);
    if (done.length) parts.push(`Finished: ${done.map(a=>a.text).join(", ")}.`);
    if (missed.length) parts.push(`Not completed: ${missed.map(a=>a.text).join(", ")} — consider carrying these forward.`);
  } else {
    parts.push("No action items were tracked today.");
  }
  if (day.notes?.trim()) {
    const firstLine = day.notes.trim().split("\n")[0].slice(0,120);
    parts.push(`Notes highlight: "${firstLine}"`);
  }
  if (day.reflection?.wins) parts.push(`Win of the day: ${day.reflection.wins}.`);
  return parts.join(" ");
}

function localParseVoice(said) {
  const s = said.trim();
  const lower = s.toLowerCase();
  // extract a time like "at 3pm", "at 15:30", "at 9:00 am"
  let dueTime = "";
  const tm = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (tm) {
    let h = parseInt(tm[1],10);
    const m = tm[2]?parseInt(tm[2],10):0;
    if (tm[3]==="pm" && h<12) h+=12;
    if (tm[3]==="am" && h===12) h=0;
    dueTime = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  const strip = (re) => s.replace(re,"").replace(/\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?/i,"").trim();

  // Classify reflection content: positive → wins, negative → missed, intent → improve
  const classifyReflection = (text) => {
    const t = text.toLowerCase();
    if (/\b(missed|skipped|forgot|failed|didn'?t|did not|couldn'?t|could not|wasn'?t able)\b/.test(t))
      return { action:"add_reflection_missed", text, dueTime:"" };
    if (/\b(should|need to|want to|improve|better|next time|going to|will try|must)\b/.test(t))
      return { action:"add_reflection_improve", text, dueTime:"" };
    // default positive: "I did it", "completed", "finished", "proud", "achieved", "won"
    return { action:"add_reflection_wins", text, dueTime:"" };
  };

  // ── DELETE commands: "delete task call mom", "delete I did it note", "remove note X" ──
  if (/^(delete|remove|clear|erase)\b/i.test(s)) {
    let rest = s.replace(/^(delete|remove|clear|erase)\b\s*/i,"").trim();
    const restLower = rest.toLowerCase();
    // figure out the type — the keyword can be anywhere ("delete note X" or "delete X note")
    const detect = (words) => words.some(w=>restLower.includes(w));
    const stripType = (words) => {
      let t = rest;
      words.forEach(w=>{ t = t.replace(new RegExp(`\\b${w}\\b`,"ig"),""); });
      return t.replace(/^[:\s]+|[:\s]+$/g,"").replace(/\s+/g," ").trim();
    };
    if (detect(["task","action","to-do","todo","reminder"]))
      return { action:"delete_action", text:stripType(["task","action","to-?do","reminder","item"]), dueTime:"" };
    if (detect(["note","notes"]))
      return { action:"delete_note", text:stripType(["notes?"]), dueTime:"" };
    if (detect(["win","wins"]))
      return { action:"delete_reflection_wins", text:stripType(["wins?","reflection"]), dueTime:"" };
    if (detect(["missed"]))
      return { action:"delete_reflection_missed", text:stripType(["missed","reflection"]), dueTime:"" };
    if (detect(["improve","improvement"]))
      return { action:"delete_reflection_improve", text:stripType(["improve(ment)?","reflection"]), dueTime:"" };
    if (detect(["reflection","reflections"]))
      return { action:"delete_reflection", text:stripType(["reflections?"]), dueTime:"" };
    if (detect(["summary"]))
      return { action:"delete_summary", text:"", dueTime:"" };
    // no type word — search everywhere for the text
    return { action:"delete_any", text:rest, dueTime:"" };
  }

  // "add reflection..." / "reflection..." → smart-classify the content
  if (/^(add |new |my )?reflection(s)?:?\s*/i.test(s))
    return classifyReflection(strip(/^(add |new |my )?reflection(s)?:?\s*/i));

  if (/^(add |new )?(action|task|to-?do|reminder)( item)?:?\s*/i.test(s))
    return { action:"add_action", text:strip(/^(add |new )?(action|task|to-?do|reminder)( item)?:?\s*/i), dueTime };
  if (/^(add |new )?(note|notes):?\s*/i.test(s))
    return { action:"add_note", text:strip(/^(add |new )?(note|notes):?\s*/i), dueTime:"" };
  if (/^(set |add )?summary:?\s*/i.test(s))
    return { action:"set_summary", text:strip(/^(set |add )?summary:?\s*/i), dueTime:"" };
  if (/^(my )?win(s)?( today)?( was| is)?:?\s*/i.test(s))
    return { action:"add_reflection_wins", text:strip(/^(my )?win(s)?( today)?( was| is)?:?\s*/i), dueTime:"" };
  if (/^i (missed|skipped|forgot|failed)\b/i.test(s) || /^missed:?\s*/i.test(s))
    return { action:"add_reflection_missed", text:s.replace(/^missed:?\s*/i,"").trim(), dueTime:"" };
  if (/^(to )?improve:?\s*/i.test(s) || /^i (should|need to|want to)\b/i.test(s))
    return { action:"add_reflection_improve", text:s.replace(/^(to )?improve:?\s*/i,"").trim(), dueTime:"" };
  // bare statements that sound like accomplishments → wins
  if (/^i (did|completed|finished|achieved|closed|got|managed)\b/i.test(s))
    return { action:"add_reflection_wins", text:s, dueTime:"" };
  // default: capture everything as a note so nothing is lost
  return { action:"add_note", text:s, dueTime:"" };
}

function localWeeklyDebrief(data, anchor) {
  const start = new Date(anchor);
  start.setDate(start.getDate() - start.getDay());
  let totalTasks=0, totalDone=0, daysTracked=0, bestDay=null, bestRate=-1;
  const allWins=[], allMissed=[], allImprove=[];
  for (let i=0;i<7;i++) {
    const d=new Date(start); d.setDate(d.getDate()+i);
    const dd=data[toKey(d)];
    if (!dd) continue;
    daysTracked++;
    const t=dd.actions?.length||0, c=dd.actions?.filter(a=>a.status==="complete").length||0;
    totalTasks+=t; totalDone+=c;
    if (t>0 && c/t>bestRate){bestRate=c/t;bestDay=DAYS[d.getDay()];}
    if (dd.reflection?.wins) allWins.push(dd.reflection.wins);
    if (dd.reflection?.missed) allMissed.push(dd.reflection.missed);
    if (dd.reflection?.improve) allImprove.push(dd.reflection.improve);
  }
  const rate = totalTasks? Math.round(totalDone/totalTasks*100):0;
  const lines = [];
  lines.push(`WEEK IN NUMBERS`);
  lines.push(`• Days tracked: ${daysTracked}/7`);
  lines.push(`• Tasks completed: ${totalDone}/${totalTasks} (${rate}%)`);
  if (bestDay) lines.push(`• Best day: ${bestDay} (${Math.round(bestRate*100)}% completion)`);
  if (allWins.length){ lines.push(``); lines.push(`WINS THIS WEEK`); allWins.forEach(w=>lines.push(`• ${w}`)); }
  if (allMissed.length){ lines.push(``); lines.push(`WHAT SLIPPED`); allMissed.forEach(m=>lines.push(`• ${m}`)); }
  if (allImprove.length){ lines.push(``); lines.push(`YOUR OWN IMPROVEMENT NOTES`); allImprove.forEach(im=>lines.push(`• ${im}`)); }
  lines.push(``);
  lines.push(rate>=70 ? `Strong week — ${rate}% completion. Keep the momentum.` :
             rate>=40 ? `Decent week at ${rate}%. Look at what slipped and carry fewer, sharper tasks next week.` :
             daysTracked===0 ? `No data this week — start tracking tomorrow!` :
             `Tough week at ${rate}%. Try planning fewer tasks per day so completion feels winnable.`);
  return lines.join("\n");
}

// ─── Notification helper ──────────────────────────────────────────────────────
function scheduleNotification(text, dueTime) {
  if (!("Notification" in window)) return;
  Notification.requestPermission().then(perm => {
    if (perm !== "granted") return;
    const [h,m] = dueTime.split(":").map(Number);
    const now = new Date();
    const fire = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    const ms = fire - now;
    if (ms > 0) setTimeout(() => new Notification("⏰ DayLock", { body: text, icon:"" }), ms);
  });
}

// ─── PDF Export (jsPDF via CDN) ───────────────────────────────────────────────
async function exportToPDF(data, anchor) {
  // Load jsPDF dynamically
  if (!window.jspdf) {
    await new Promise((res,rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4" });
  const W = doc.internal.pageSize.getWidth();
  const margin = 48;
  let y = margin;

  const line = (txt, size=11, color=[220,210,200], bold=false, indent=0) => {
    if (y > 780) { doc.addPage(); y = margin; }
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.setFont("helvetica", bold?"bold":"normal");
    const lines = doc.splitTextToSize(txt, W - margin*2 - indent);
    doc.text(lines, margin+indent, y);
    y += lines.length * (size * 1.45);
  };
  const rule = (c=[40,40,40]) => {
    if (y>780){doc.addPage();y=margin;}
    doc.setDrawColor(...c);
    doc.line(margin, y, W-margin, y);
    y += 10;
  };
  const gap = (n=8) => { y += n; };

  // Title
  doc.setFillColor(12,12,12);
  doc.rect(0,0,W,60,"F");
  doc.setFontSize(20); doc.setTextColor(200,169,110); doc.setFont("helvetica","bold");
  doc.text("DayLock — Weekly Export", margin, 38);
  y = 76;

  // Week days
  const start = new Date(anchor);
  start.setDate(start.getDate() - start.getDay());

  for (let i=0;i<7;i++) {
    const d = new Date(start); d.setDate(d.getDate()+i);
    const key = toKey(d);
    const dd = data[key];
    const label = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

    gap(14);
    doc.setFillColor(22,22,22);
    doc.roundedRect(margin-8, y-14, W-margin*2+16, 22, 4,4,"F");
    line(label, 13, [200,169,110], true);
    rule([35,35,35]);

    if (!dd) { line("No data recorded.", 10, [80,80,80]); gap(6); continue; }

    if (dd.notes?.trim()) {
      line("NOTES", 9, [100,100,100], true);
      line(dd.notes.trim(), 10, [200,195,185], false, 8);
      gap(6);
    }
    if (dd.actions?.length) {
      line("ACTION ITEMS", 9, [100,100,100], true);
      dd.actions.forEach(a => {
        const icon = a.status==="complete"?"[✓]":a.status==="incomplete"?"[✗]":"[ ]";
        const t = a.dueTime ? ` (due ${a.dueTime})` : "";
        line(`${icon}  ${a.text}${t}`, 10, a.status==="complete"?[80,140,90]:a.status==="incomplete"?[160,90,90]:[190,185,175], false, 8);
      });
      gap(6);
    }
    if (dd.summary?.trim()) {
      line("SUMMARY", 9, [100,100,100], true);
      line(dd.summary.trim(), 10, [200,195,185], false, 8);
      gap(6);
    }
    const ref = dd.reflection || {};
    if (ref.wins||ref.missed||ref.improve) {
      line("REFLECTION", 9, [100,100,100], true);
      if (ref.wins)    line(`Wins: ${ref.wins}`, 10, [130,190,130], false, 8);
      if (ref.missed)  line(`Missed: ${ref.missed}`, 10, [190,130,130], false, 8);
      if (ref.improve) line(`Improve: ${ref.improve}`, 10, [190,175,130], false, 8);
      gap(6);
    }
  }

  // Footer
  gap(16);
  rule([40,40,40]);
  line(`Exported ${new Date().toLocaleString()}`, 9, [80,80,80]);

  doc.save(`daylock-week-${toKey(anchor)}.pdf`);
}

// ─── Voice Assistant ──────────────────────────────────────────────────────────
function useVoice({ onCommand, onSuccess }) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("");
  const recognitionRef = useRef(null);

  const start = useCallback(async () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus("Speech recognition not supported in this browser. Try Chrome."); return; }
    if (listening) { recognitionRef.current?.stop(); return; }

    const r = new SR();
    r.lang = "en-US"; r.continuous = false; r.interimResults = false;
    recognitionRef.current = r;

    r.onstart = () => { setListening(true); setStatus("Listening… speak now"); setTranscript(""); };
    r.onresult = async (e) => {
      const said = e.results[0][0].transcript;
      setTranscript(said);
      setListening(false);
      setProcessing(true);
      setStatus("Processing…");
      try {
        const result = await callClaude(
          `You are a voice command parser for a daily productivity app. 
Parse the user's spoken command and return ONLY a JSON object (no markdown) with these fields:
{
  "action": "add_note"|"add_action"|"set_summary"|"add_reflection_wins"|"add_reflection_missed"|"add_reflection_improve"|"delete_action"|"delete_note"|"delete_summary"|"delete_reflection_wins"|"delete_reflection_missed"|"delete_reflection_improve"|"delete_reflection"|"delete_any"|"unknown",
  "text": "the content to add, or for deletes: the words identifying which item to delete",
  "dueTime": "HH:MM or empty string"
}
Examples:
- "Add a note: had a great meeting with the team" → action:add_note, text:"had a great meeting with the team"
- "Add action item: call John at 3pm" → action:add_action, text:"call John", dueTime:"15:00"
- "My win today was closing the deal" → action:add_reflection_wins, text:"closing the deal"
- "I missed the standup" → action:add_reflection_missed, text:"missed the standup"
- "To improve, I should wake up earlier" → action:add_reflection_improve, text:"wake up earlier"
- "Add reflection: I did it" → action:add_reflection_wins, text:"I did it" (positive accomplishments go to wins)
- "Add reflection: I couldn't finish the report" → action:add_reflection_missed, text:"I couldn't finish the report"
- "Add reflection: I should plan mornings better" → action:add_reflection_improve, text:"I should plan mornings better"
- "Delete task call John" → action:delete_action, text:"call John"
- "Delete I did it note" → action:delete_note, text:"I did it"
- "Remove my win about the deal" → action:delete_reflection_wins, text:"the deal"
- "Delete the reflection about mornings" → action:delete_reflection, text:"mornings"
- "Clear the summary" → action:delete_summary, text:""
- "Delete the gym thing" → action:delete_any, text:"gym" (type unclear — search everywhere)
- "Set summary: productive day" → action:set_summary, text:"productive day"
Rule: when the user says "reflection", classify the content — accomplishments/positive → add_reflection_wins, failures/missed things → add_reflection_missed, intentions/improvements → add_reflection_improve. Never default reflections to add_note.`,
          said, true
        );
        if (result && result.action !== "unknown") {
          onCommand(result);
          setStatus(`✓ Done: ${result.action.replace(/_/g," ")} — "${result.text}"`);
          onSuccess && onSuccess();
        } else {
          setStatus("Didn't understand the command. Try: 'Add action: call John at 3pm'");
        }
      } catch(err) {
        // FREE fallback: parse the command locally (no AI needed)
        const result = localParseVoice(said);
        onCommand(result);
        setStatus(`✓ Done: ${result.action.replace(/_/g," ")} — "${result.text}"`);
        onSuccess && onSuccess();
      }
      setProcessing(false);
    };
    r.onerror = (e) => { setListening(false); setStatus("Mic error: " + e.error); };
    r.onend   = () => { setListening(false); };
    r.start();
  }, [listening, onCommand, onSuccess]);

  const stop = useCallback(() => { recognitionRef.current?.stop(); setListening(false); }, []);
  return { listening, transcript, processing, status, start, stop };
}

// ─── AI Weekly Debrief ────────────────────────────────────────────────────────
async function generateWeeklyDebrief(data, anchor) {
  const start = new Date(anchor);
  start.setDate(start.getDate() - start.getDay());
  const days = [];
  for (let i=0;i<7;i++) {
    const d = new Date(start); d.setDate(d.getDate()+i);
    const key = toKey(d);
    const dd = data[key];
    if (!dd) { days.push(`${DAYS[d.getDay()]}: no data`); continue; }
    const done = dd.actions?.filter(a=>a.status==="complete").length||0;
    const total = dd.actions?.length||0;
    days.push(`${DAYS[d.getDay()]}: ${done}/${total} tasks done. Notes: ${dd.notes?.slice(0,80)||"none"}. Wins: ${dd.reflection?.wins||"none"}. Missed: ${dd.reflection?.missed||"none"}. Improve: ${dd.reflection?.improve||"none"}.`);
  }
  return callClaude(
    `You are a warm but direct personal productivity coach. Analyze this person's week and give a Sunday debrief in 200-250 words. Structure it as: 
1. Week in review (2-3 sentences)  
2. Patterns you notice (good and bad)  
3. 3 specific, actionable recommendations for next week  
Be personal, specific, and encouraging but honest. Plain text, no markdown.`,
    days.join("\n")
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ icon, title, badge, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom:16, border:"1px solid #1c1c1c", borderRadius:14, overflow:"hidden" }}>
      <button onClick={()=>setOpen(o=>!o)} style={{
        width:"100%", display:"flex", alignItems:"center", gap:10,
        background:"#0f0f0f", border:"none", cursor:"pointer", padding:"13px 18px", textAlign:"left"
      }}>
        <span style={{fontSize:17}}>{icon}</span>
        <span style={{color:"#f0e6d3",fontFamily:"'Playfair Display',serif",fontSize:14,flex:1}}>{title}</span>
        {badge && <span style={{fontSize:11,color:"#c8a96e",fontFamily:"'DM Mono',monospace",background:"#1a1400",padding:"2px 8px",borderRadius:20}}>{badge}</span>}
        <span style={{color:"#444",fontSize:11}}>{open?"▲":"▼"}</span>
      </button>
      {open && <div style={{background:"#090909",padding:"16px 18px"}}>{children}</div>}
    </div>
  );
}

function NotesSection({ day, onChange }) {
  return (
    <Section icon="📝" title="Daily Notes">
      <textarea value={day.notes} onChange={e=>onChange({notes:e.target.value})}
        placeholder="Stream of consciousness, observations, thoughts throughout the day…"
        style={{...TA, minHeight:130}}/>
    </Section>
  );
}

function ActionsSection({ day, onChange, carryFrom, onCarrySelect }) {
  const [newText, setNewText] = useState("");
  const [newTime, setNewTime] = useState("");
  const allReviewed = day.actions.length===0 || day.actions.every(a=>a.status!=="pending");
  const done = day.actions.filter(a=>a.status==="complete").length;

  const add = () => {
    if (!newText.trim()) return;
    const action = { id:uid(), text:newText.trim(), status:"pending", dueTime:newTime };
    onChange({ actions:[...day.actions, action] });
    if (newTime) scheduleNotification(newText.trim(), newTime);
    setNewText(""); setNewTime("");
  };
  const setStatus = (id,status) => onChange({ actions:day.actions.map(a=>a.id===id?{...a,status}:a) });
  const remove = (id) => onChange({ actions:day.actions.filter(a=>a.id!==id) });

  return (
    <Section icon="✅" title="Action Items" badge={day.actions.length?`${done}/${day.actions.length}`:undefined}>
      {!allReviewed && day.actions.length>0 && (
        <div style={{background:"#150e00",border:"1px solid #c8a96e33",borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:11,color:"#c8a96e",fontFamily:"'DM Mono',monospace"}}>
          ⚠ Mark every item ✓ or ✗ to unlock the next day
        </div>
      )}
      <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
        <input value={newText} onChange={e=>setNewText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()}
          placeholder="Add action item…" style={{...IN, flex:"1 1 200px"}}/>
        <input type="time" value={newTime} onChange={e=>setNewTime(e.target.value)}
          title="Set reminder time" style={{...IN, width:110, color: newTime?"#c8a96e":"#555"}}/>
        <button onClick={add} style={BTN}>+ Add</button>
      </div>

      {carryFrom.length>0 && (
        <div style={{marginBottom:12,padding:"10px 12px",background:"#0d1a0d",border:"1px solid #2a4a2a",borderRadius:10}}>
          <div style={{color:"#6ec88a",fontSize:10,fontFamily:"'DM Mono',monospace",marginBottom:8}}>↑ CARRY FORWARD FROM YESTERDAY</div>
          {carryFrom.map(a=>(
            <div key={a.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:"1px solid #1a2a1a"}}>
              <span style={{flex:1,color:"#5a8a5a",fontSize:12,fontFamily:"'DM Mono',monospace"}}>{a.text}</span>
              <button onClick={()=>onCarrySelect(a)} style={{...SB,color:"#6ec88a",border:"1px solid #6ec88a44",background:"#0d1a0d"}}>↑ Carry</button>
            </div>
          ))}
        </div>
      )}

      {day.actions.map(a=>(
        <div key={a.id} style={{
          display:"flex",alignItems:"center",gap:8,padding:"9px 12px",marginBottom:6,
          borderRadius:10,background:"#0f0f0f",
          border:`1px solid ${a.status==="complete"?"#6ec88a33":a.status==="incomplete"?"#c86e6e33":"#1a1a1a"}`
        }}>
          <button onClick={()=>setStatus(a.id,"complete")} style={{
            width:20,height:20,borderRadius:"50%",border:"2px solid",flexShrink:0,cursor:"pointer",fontSize:10,
            borderColor:a.status==="complete"?"#6ec88a":"#333",
            background:a.status==="complete"?"#6ec88a":"transparent",color:"#111"
          }}>{a.status==="complete"?"✓":""}</button>
          <div style={{flex:1,minWidth:0}}>
            <div style={{
              fontSize:12,fontFamily:"'DM Mono',monospace",
              color:a.status==="complete"?"#4a7a5a":a.status==="incomplete"?"#7a4a4a":"#d0c8bc",
              textDecoration:a.status==="complete"?"line-through":"none",
              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"
            }}>{a.text}</div>
            {a.dueTime && <div style={{fontSize:10,color:"#c8a96e",fontFamily:"'DM Mono',monospace",marginTop:2}}>⏰ {a.dueTime}</div>}
          </div>
          <button onClick={()=>setStatus(a.id,"incomplete")} style={{
            ...SB,
            background:a.status==="incomplete"?"#1f0a0a":"transparent",
            color:a.status==="incomplete"?"#c86e6e":"#333",
            border:`1px solid ${a.status==="incomplete"?"#c86e6e44":"#1a1a1a"}`
          }}>✗</button>
          <button onClick={()=>remove(a.id)} style={{...SB,color:"#2a2a2a",border:"1px solid #1a1a1a"}}>🗑</button>
        </div>
      ))}
      {day.actions.length===0 && <div style={{color:"#2a2a2a",fontSize:11,fontFamily:"'DM Mono',monospace",textAlign:"center",padding:"10px 0"}}>No actions yet</div>}
    </Section>
  );
}

function SummarySection({ day, onChange }) {
  const [loading, setLoading] = useState(false);
  const generate = async () => {
    setLoading(true);
    try {
      const result = await callClaude(
        "Write a concise, warm end-of-day summary (max 130 words). Plain text only.",
        `Notes: ${day.notes||"none"}\nCompleted: ${day.actions.filter(a=>a.status==="complete").map(a=>a.text).join(", ")||"none"}\nIncomplete: ${day.actions.filter(a=>a.status==="incomplete").map(a=>a.text).join(", ")||"none"}`
      );
      onChange({ summary:result, summaryGenerated:true });
    } catch(e){
      // FREE fallback: smart template summary (no AI needed)
      onChange({ summary: localSummary(day), summaryGenerated:true });
    }
    setLoading(false);
  };
  return (
    <Section icon="🌅" title="End-of-Day Summary">
      <textarea value={day.summary} onChange={e=>onChange({summary:e.target.value})}
        placeholder="Write your day summary, or generate one with AI…" style={{...TA,minHeight:90}}/>
      <button onClick={generate} disabled={loading} style={{...BTN,marginTop:8,background:"#120f00",border:"1px solid #c8a96e55",color:"#c8a96e",opacity:loading?.6:1}}>
        {loading?"✨ Generating…":"✨ AI Generate Summary"}
      </button>
    </Section>
  );
}

function ReflectionSection({ day, onChange }) {
  const patch = (f,v) => onChange({ reflection:{...day.reflection,[f]:v} });
  return (
    <Section icon="🪞" title="Reflection">
      {[
        {key:"wins",label:"🏆 Wins & what went well",ph:"What are you proud of today?"},
        {key:"missed",label:"⚠ What was missed",ph:"What didn't get done or could've gone better?"},
        {key:"improve",label:"💡 How to improve tomorrow",ph:"Concrete lessons, mindset shifts…"},
      ].map(({key,label,ph})=>(
        <div key={key} style={{marginBottom:12}}>
          <div style={{color:"#555",fontSize:10,fontFamily:"'DM Mono',monospace",marginBottom:4}}>{label}</div>
          <textarea value={day.reflection[key]||""} onChange={e=>patch(key,e.target.value)}
            placeholder={ph} style={{...TA,minHeight:64}}/>
        </div>
      ))}
    </Section>
  );
}

// ─── Voice Panel ──────────────────────────────────────────────────────────────
function VoicePanel({ onCommand, onClose }) {
  const closeTimer = useRef(null);
  const { listening, transcript, processing, status, start, stop } = useVoice({
    onCommand,
    onSuccess: () => {
      // auto-close shortly after success so the user sees their action applied
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(onClose, 1200);
    }
  });
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return (
    <div style={{
      position:"fixed",inset:0,background:"rgba(4,4,4,0.95)",zIndex:300,
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
      backdropFilter:"blur(8px)"
    }}>
      <div style={{textAlign:"center",maxWidth:460,padding:"0 24px"}}>
        <div style={{fontFamily:"'Playfair Display',serif",fontSize:28,color:"#f0e6d3",marginBottom:8}}>Voice Assistant</div>
        <div style={{color:"#555",fontSize:12,fontFamily:"'DM Mono',monospace",marginBottom:40,lineHeight:1.7}}>
          Say things like:<br/>
          <span style={{color:"#c8a96e"}}>"Add action: call John at 3pm"</span><br/>
          <span style={{color:"#c8a96e"}}>"Add a note: had a great meeting"</span><br/>
          <span style={{color:"#c8a96e"}}>"My win today was closing the deal"</span><br/>
          <span style={{color:"#c8a96e"}}>"Delete task call John"</span><br/>
          <span style={{color:"#c8a96e"}}>"Delete the note about the meeting"</span>
        </div>

        {/* Mic button */}
        <button onClick={listening?stop:start} style={{
          width:100,height:100,borderRadius:"50%",border:"none",cursor:"pointer",
          background: listening
            ? "radial-gradient(circle, #c86e6e, #8a2a2a)"
            : "radial-gradient(circle, #c8a96e, #8a6a2e)",
          fontSize:36,marginBottom:24,
          boxShadow: listening ? "0 0 0 16px rgba(200,110,110,0.15), 0 0 0 32px rgba(200,110,110,0.07)" : "0 0 0 8px rgba(200,169,110,0.1)",
          transition:"all 0.3s",
          animation: listening ? "pulse 1.2s ease-in-out infinite" : "none"
        }}>🎤</button>

        <style>{`@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}`}</style>

        <div style={{minHeight:24,marginBottom:12,color: listening?"#c86e6e":processing?"#c8a96e":"#6ec88a",fontSize:13,fontFamily:"'DM Mono',monospace"}}>
          {listening?"● LISTENING":processing?"⟳ PROCESSING":status||"Tap the mic to speak"}
        </div>

        {transcript && (
          <div style={{background:"#111",border:"1px solid #1e1e1e",borderRadius:10,padding:"10px 16px",marginBottom:16,color:"#d0c8bc",fontSize:12,fontFamily:"'DM Mono',monospace",fontStyle:"italic"}}>
            "{transcript}"
          </div>
        )}

        <button onClick={onClose} style={{...SB,padding:"10px 28px",color:"#888",border:"1px solid #222",marginTop:8}}>✕ Close</button>
      </div>
    </div>
  );
}

// ─── Calendar Picker ──────────────────────────────────────────────────────────
function CalendarPicker({ current, onSelect, onClose, data }) {
  const [view, setView] = useState(new Date(current.getFullYear(), current.getMonth(), 1));
  const year=view.getFullYear(), month=view.getMonth();
  const firstDay=new Date(year,month,1).getDay(), dim=new Date(year,month+1,0).getDate();
  const cells=[];
  for(let i=0;i<firstDay;i++) cells.push(null);
  for(let d=1;d<=dim;d++) cells.push(d);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(4,4,4,0.8)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0e0e0e",border:"1px solid #222",borderRadius:16,padding:24,width:310,boxShadow:"0 24px 80px rgba(0,0,0,0.9)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <button onClick={()=>setView(new Date(year,month-1,1))} style={NV}>‹</button>
          <span style={{color:"#f0e6d3",fontFamily:"'Playfair Display',serif",fontSize:17}}>{MONTHS[month]} {year}</span>
          <button onClick={()=>setView(new Date(year,month+1,1))} style={NV}>›</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,marginBottom:6}}>
          {DAYS.map(d=><div key={d} style={{textAlign:"center",color:"#444",fontSize:10,fontFamily:"'DM Mono',monospace"}}>{d}</div>)}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
          {cells.map((d,i)=>{
            if(!d) return <div key={i}/>;
            const date=new Date(year,month,d);
            const key=toKey(date);
            const isTd=toKey(date)===toKey(todayDate());
            const isSel=toKey(date)===toKey(current);
            const dd=data[key];
            const allR=dd?.actions?.length>0&&dd.actions.every(a=>a.status!=="pending");
            return (
              <button key={i} onClick={()=>{onSelect(date);onClose();}} style={{
                background:isSel?"#c8a96e":isTd?"#181818":"transparent",
                border:isTd?"1px solid #c8a96e44":"1px solid transparent",
                borderRadius:7,color:isSel?"#111":"#f0e6d3",
                padding:"5px 0",cursor:"pointer",fontSize:12,
                fontFamily:"'DM Mono',monospace",position:"relative"
              }}>
                {d}
                {dd&&!isSel&&<span style={{position:"absolute",bottom:1,left:"50%",transform:"translateX(-50%)",width:3,height:3,borderRadius:"50%",background:allR?"#6ec88a":"#c8a96e"}}/>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Weekly View ──────────────────────────────────────────────────────────────
function WeeklyView({ data, anchor, onClose, onJump }) {
  const [debrief, setDebrief] = useState("");
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const start = new Date(anchor);
  start.setDate(start.getDate()-start.getDay());
  const days = Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return d;});

  const runDebrief = async () => {
    setDebriefLoading(true);
    try {
      const r = await generateWeeklyDebrief(data, anchor);
      setDebrief(r);
    } catch(e) {
      // FREE fallback: stats-based weekly report (no AI needed)
      setDebrief(localWeeklyDebrief(data, anchor));
    }
    setDebriefLoading(false);
  };

  const runExport = async () => {
    setExporting(true);
    await exportToPDF(data, anchor);
    setExporting(false);
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(4,4,4,0.96)",zIndex:150,overflowY:"auto"}}>
      <div style={{maxWidth:800,margin:"0 auto",padding:"36px 20px 80px"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:28,flexWrap:"wrap"}}>
          <h2 style={{color:"#f0e6d3",fontFamily:"'Playfair Display',serif",margin:0,fontSize:24,flex:1}}>Weekly Overview</h2>
          <button onClick={runDebrief} disabled={debriefLoading} style={{...BTN,background:"#120f00",border:"1px solid #c8a96e55",color:"#c8a96e",opacity:debriefLoading?.6:1}}>
            {debriefLoading?"✨ Analyzing…":"✨ AI Weekly Debrief"}
          </button>
          <button onClick={runExport} disabled={exporting} style={{...BTN,background:"#0a120a",border:"1px solid #6ec88a55",color:"#6ec88a",opacity:exporting?.6:1}}>
            {exporting?"⏳ Exporting…":"📄 Export PDF"}
          </button>
          <button onClick={onClose} style={{...SB,padding:"8px 16px",color:"#888",border:"1px solid #222"}}>✕</button>
        </div>

        {/* Day cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:8,marginBottom:24}}>
          {days.map(d=>{
            const key=toKey(d);
            const dd=data[key];
            const total=dd?.actions?.length||0;
            const done=dd?.actions?.filter(a=>a.status==="complete").length||0;
            const allR=total>0&&dd.actions.every(a=>a.status!=="pending");
            const isT=toKey(d)===toKey(todayDate());
            return (
              <div key={key} onClick={()=>{onJump(d);onClose();}} style={{
                background:"#0d0d0d",border:`1px solid ${isT?"#c8a96e44":"#181818"}`,
                borderRadius:12,padding:"12px 8px",cursor:"pointer",transition:"border-color .2s"
              }}
              onMouseEnter={e=>e.currentTarget.style.borderColor="#c8a96e"}
              onMouseLeave={e=>e.currentTarget.style.borderColor=isT?"#c8a96e44":"#181818"}>
                <div style={{color:"#c8a96e",fontSize:9,fontFamily:"'DM Mono',monospace",marginBottom:3}}>{DAYS[d.getDay()]}</div>
                <div style={{color:"#f0e6d3",fontFamily:"'Playfair Display',serif",fontSize:19,marginBottom:6}}>{d.getDate()}</div>
                {dd?(
                  <>
                    <div style={{color:allR?"#6ec88a":"#c8a96e",fontSize:9,fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                      {total?`${done}/${total}`:"no tasks"}
                    </div>
                    {dd.summary&&<div style={{color:"#444",fontSize:9,lineHeight:1.4,overflow:"hidden",maxHeight:44}}>{dd.summary.slice(0,70)}</div>}
                  </>
                ):<div style={{color:"#2a2a2a",fontSize:9,fontFamily:"'DM Mono',monospace"}}>empty</div>}
              </div>
            );
          })}
        </div>

        {/* AI Debrief */}
        {debrief && (
          <div style={{background:"#0d0d00",border:"1px solid #c8a96e33",borderRadius:14,padding:20,marginBottom:24}}>
            <div style={{color:"#c8a96e",fontSize:11,fontFamily:"'DM Mono',monospace",marginBottom:10}}>✨ AI WEEKLY DEBRIEF</div>
            <div style={{color:"#d0c8bc",fontSize:13,lineHeight:1.75,fontFamily:"'DM Mono',monospace",whiteSpace:"pre-wrap"}}>{debrief}</div>
          </div>
        )}

        {/* Day details */}
        {days.map(d=>{
          const key=toKey(d);
          const dd=data[key];
          if(!dd?.reflection?.missed&&!dd?.reflection?.improve&&!dd?.reflection?.wins&&!dd?.summary) return null;
          return (
            <div key={key} style={{marginBottom:16,padding:16,background:"#0d0d0d",borderRadius:14,border:"1px solid #181818"}}>
              <div style={{color:"#c8a96e",fontFamily:"'Playfair Display',serif",marginBottom:10,fontSize:13}}>
                {DAYS[d.getDay()]}, {MONTHS[d.getMonth()]} {d.getDate()}
              </div>
              {dd.summary&&<div style={{marginBottom:8}}><span style={{color:"#333",fontSize:10}}>SUMMARY  </span><span style={{color:"#d0c8bc",fontSize:12}}>{dd.summary}</span></div>}
              {dd.reflection?.wins&&<div style={{marginBottom:6}}><span style={{color:"#333",fontSize:10}}>WINS  </span><span style={{color:"#a0d0a0",fontSize:12}}>{dd.reflection.wins}</span></div>}
              {dd.reflection?.missed&&<div style={{marginBottom:6}}><span style={{color:"#333",fontSize:10}}>MISSED  </span><span style={{color:"#d0a0a0",fontSize:12}}>{dd.reflection.missed}</span></div>}
              {dd.reflection?.improve&&<div><span style={{color:"#333",fontSize:10}}>IMPROVE  </span><span style={{color:"#d0c8a0",fontSize:12}}>{dd.reflection.improve}</span></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [current, setCurrent] = useState(todayDate());
  const [showCal, setShowCal] = useState(false);
  const [showWeekly, setShowWeekly] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [blockMsg, setBlockMsg] = useState("");
  const { data, getDay, patchDay } = useStore();

  const key = toKey(current);
  const day = getDay(key);
  const patch = (p) => patchDay(key, p);
  const isToday = key === toKey(todayDate());
  const allReviewed = day.actions.length===0 || day.actions.every(a=>a.status!=="pending");

  const navigate = (dir) => {
    if (dir>0 && !allReviewed) {
      setBlockMsg("Mark every action ✓ complete or ✗ incomplete before advancing.");
      setTimeout(()=>setBlockMsg(""),3500); return;
    }
    const next = new Date(current); next.setDate(next.getDate()+dir); setCurrent(next);
  };

  // Voice command handler
  const handleVoiceCommand = useCallback(({ action, text, dueTime }) => {
    const d = getDay(key);

    // ── fuzzy matching helpers for delete ──
    const norm = (t) => t.toLowerCase().replace(/[^\w\s]/g,"").trim();
    const matches = (candidate, target) => {
      const c = norm(candidate), t = norm(target);
      if (!t) return false;
      if (c.includes(t) || t.includes(c)) return true;
      const tw = t.split(/\s+/), cw = new Set(c.split(/\s+/));
      const overlap = tw.filter(w=>cw.has(w)).length;
      return overlap / tw.length >= 0.6; // 60% of spoken words found
    };
    const removeSentence = (field, target) => {
      const parts = field.split(/(?<=[.!?\n])\s*/).filter(Boolean);
      const kept = parts.filter(p=>!matches(p, target));
      return kept.length===parts.length ? null : kept.join(" ").trim();
    };
    const deleteFromReflection = (fields, target) => {
      let changed = false;
      const next = { ...d.reflection };
      for (const f of fields) {
        if (!next[f]) continue;
        const result = removeSentence(next[f], target);
        if (result !== null) { next[f] = result; changed = true; }
      }
      if (changed) patchDay(key,{reflection:next});
      return changed;
    };
    const deleteAction = (target) => {
      const found = d.actions.find(a=>matches(a.text, target));
      if (found) { patchDay(key,{actions:d.actions.filter(a=>a.id!==found.id)}); return true; }
      return false;
    };
    const deleteNoteLine = (target) => {
      const lines = d.notes.split("\n").filter(Boolean);
      const kept = lines.filter(l=>!matches(l, target));
      if (kept.length!==lines.length) { patchDay(key,{notes:kept.join("\n")}); return true; }
      return false;
    };

    if (action==="add_note")              patchDay(key,{notes:(d.notes?d.notes+"\n":"")+text});
    else if (action==="add_action")       patchDay(key,{actions:[...d.actions,{id:uid(),text,status:"pending",dueTime:dueTime||""}]});
    else if (action==="set_summary")      patchDay(key,{summary:text});
    else if (action==="add_reflection_wins")    patchDay(key,{reflection:{...d.reflection,wins:(d.reflection.wins?d.reflection.wins+". ":"")+text}});
    else if (action==="add_reflection_missed")  patchDay(key,{reflection:{...d.reflection,missed:(d.reflection.missed?d.reflection.missed+". ":"")+text}});
    else if (action==="add_reflection_improve") patchDay(key,{reflection:{...d.reflection,improve:(d.reflection.improve?d.reflection.improve+". ":"")+text}});
    // ── deletes ──
    else if (action==="delete_action")            deleteAction(text);
    else if (action==="delete_note")              deleteNoteLine(text);
    else if (action==="delete_summary")           patchDay(key,{summary:""});
    else if (action==="delete_reflection_wins")   deleteFromReflection(["wins"], text);
    else if (action==="delete_reflection_missed") deleteFromReflection(["missed"], text);
    else if (action==="delete_reflection_improve")deleteFromReflection(["improve"], text);
    else if (action==="delete_reflection")        deleteFromReflection(["wins","missed","improve"], text);
    else if (action==="delete_any") {
      // search everywhere: tasks first, then notes, then all reflection fields
      deleteAction(text) || deleteNoteLine(text) || deleteFromReflection(["wins","missed","improve"], text);
    }
  }, [key, getDay, patchDay]);

  // Carry-forward from previous day
  const prevKey = toKey(new Date(current.getTime()-86400000));
  const prevDay = getDay(prevKey);
  const carryOptions = (prevDay.actions||[]).filter(a=>a.status==="incomplete");
  const handleCarry = (action) => {
    if (day.actions.find(a=>a.text===action.text)) return;
    patch({ actions:[...day.actions,{id:uid(),text:action.text,status:"pending",dueTime:""}] });
  };

  // Keyboard shortcut: Ctrl+Shift+V for voice
  useEffect(()=>{
    const handler = (e) => { if (e.ctrlKey&&e.shiftKey&&e.key==="V") setShowVoice(v=>!v); };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[]);

  return (
    <div style={{minHeight:"100vh",background:"#060606",color:"#f0e6d3",fontFamily:"'DM Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=DM+Mono:wght@300;400;500&display=swap');
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:5px;}
        ::-webkit-scrollbar-track{background:#060606;}
        ::-webkit-scrollbar-thumb{background:#1a1a1a;border-radius:3px;}
        textarea:focus,input:focus{outline:none;border-color:#c8a96e55!important;}
        button:hover{opacity:.85;}
        input[type="time"]::-webkit-calendar-picker-indicator{filter:invert(.4);}
      `}</style>

      {/* Header */}
      <div style={{
        position:"sticky",top:0,zIndex:100,
        background:"rgba(6,6,6,0.97)",backdropFilter:"blur(16px)",
        borderBottom:"1px solid #141414",padding:"14px 20px",
        display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"
      }}>
        <div>
          <div style={{color:"#c8a96e",fontSize:9,letterSpacing:"0.18em",marginBottom:1}}>DAYLOCK</div>
          <div style={{fontFamily:"'Playfair Display',serif",fontSize:20,color:"#f0e6d3"}}>
            {MONTHS[current.getMonth()]} {current.getDate()}, {current.getFullYear()}
            {isToday&&<span style={{marginLeft:10,fontSize:10,color:"#6ec88a",verticalAlign:"middle",fontFamily:"'DM Mono',monospace"}}>● TODAY</span>}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,marginLeft:"auto",flexWrap:"wrap"}}>
          <button onClick={()=>navigate(-1)} style={NV}>‹</button>
          <button onClick={()=>setShowCal(true)} style={{...NV,fontSize:14}}>📅</button>
          <button onClick={()=>navigate(1)} style={NV}>›</button>
          <button onClick={()=>setShowWeekly(true)} style={{...NV,padding:"6px 12px",fontSize:11,color:"#c8a96e"}}>Week</button>
          {/* Voice button */}
          <button onClick={()=>setShowVoice(true)} style={{
            ...NV,padding:"6px 12px",fontSize:11,
            background:"#1a0a00",border:"1px solid #c8a96e55",color:"#c8a96e",
            display:"flex",alignItems:"center",gap:5
          }}>🎤 <span>Voice</span></button>
        </div>
      </div>

      {/* Status bar */}
      <div style={{background:"#080808",borderBottom:"1px solid #111",padding:"7px 20px",display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:10,color:allReviewed&&day.actions.length>0?"#6ec88a":"#333"}}>
          {allReviewed&&day.actions.length>0?"✓ Day unlocked":day.actions.length>0?"⚠ Review pending":"No tasks"}
        </span>
        <span style={{fontSize:10,color:"#1a1a1a"}}>|</span>
        <span style={{fontSize:10,color:day.summary?"#6ec88a":"#333"}}>{day.summary?"✓ Summary":"○ No summary"}</span>
        <span style={{fontSize:10,color:"#1a1a1a"}}>|</span>
        <span style={{fontSize:10,color:day.notes?"#6ec88a":"#333"}}>{day.notes?"✓ Notes":"○ No notes"}</span>
        <span style={{fontSize:10,color:"#2a2a2a",marginLeft:"auto"}}>Ctrl+Shift+V → Voice</span>
      </div>

      {/* Block toast */}
      {blockMsg&&(
        <div style={{
          position:"fixed",top:74,left:"50%",transform:"translateX(-50%)",
          background:"#140800",border:"1px solid #c8a96e",borderRadius:10,
          padding:"11px 20px",color:"#c8a96e",fontSize:12,zIndex:999,
          fontFamily:"'DM Mono',monospace",maxWidth:360,textAlign:"center",
          boxShadow:"0 8px 40px rgba(0,0,0,0.9)"
        }}>⚠ {blockMsg}</div>
      )}

      {/* Content */}
      <div style={{maxWidth:700,margin:"0 auto",padding:"20px 16px 80px"}}>
        <NotesSection day={day} onChange={patch}/>
        <ActionsSection day={day} onChange={patch} carryFrom={carryOptions} onCarrySelect={handleCarry}/>
        <SummarySection day={day} onChange={patch}/>
        <ReflectionSection day={day} onChange={patch}/>
      </div>

      {/* Floating voice button (mobile) */}
      <button onClick={()=>setShowVoice(true)} style={{
        position:"fixed",bottom:28,right:24,width:58,height:58,
        borderRadius:"50%",border:"none",cursor:"pointer",zIndex:90,
        background:"radial-gradient(circle, #c8a96e, #8a6a2e)",
        fontSize:22,boxShadow:"0 4px 24px rgba(200,169,110,0.35)",
        display:"flex",alignItems:"center",justifyContent:"center"
      }}>🎤</button>

      {showCal&&<CalendarPicker current={current} onSelect={d=>{
        const going=d>current;
        if(going&&!allReviewed){setBlockMsg("Review all actions before jumping forward.");setShowCal(false);setTimeout(()=>setBlockMsg(""),3000);return;}
        setCurrent(d);
      }} onClose={()=>setShowCal(false)} data={data}/>}

      {showWeekly&&<WeeklyView data={data} anchor={current} onClose={()=>setShowWeekly(false)} onJump={setCurrent}/>}
      {showVoice&&<VoicePanel onCommand={handleVoiceCommand} onClose={()=>setShowVoice(false)}/>}
    </div>
  );
}

// ─── Shared style tokens ──────────────────────────────────────────────────────
const TA = { width:"100%",background:"#0f0f0f",border:"1px solid #1a1a1a",borderRadius:10,color:"#d0c8bc",padding:"11px 13px",fontFamily:"'DM Mono',monospace",fontSize:12,lineHeight:1.65,resize:"vertical",transition:"border-color .2s" };
const IN = { background:"#0f0f0f",border:"1px solid #1a1a1a",borderRadius:10,color:"#d0c8bc",padding:"9px 12px",fontFamily:"'DM Mono',monospace",fontSize:12,transition:"border-color .2s" };
const BTN = { background:"#141414",border:"1px solid #242424",borderRadius:10,color:"#f0e6d3",padding:"9px 14px",cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:11,whiteSpace:"nowrap",transition:"all .15s" };
const SB  = { background:"transparent",border:"1px solid #1a1a1a",borderRadius:8,color:"#444",padding:"4px 9px",cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:10 };
const NV  = { background:"transparent",border:"1px solid #1a1a1a",borderRadius:8,color:"#f0e6d3",padding:"6px 11px",cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:15 };
