import {useEffect,useRef,useState} from 'react';
import {longDate,parseDay} from './dates';
export interface Command {id:string;title:string;subtitle?:string;shortcut?:string;keywords?:string;run:()=>void}
export function CommandPalette({commands,onClose,onDate}:{commands:Command[];onClose:()=>void;onDate:(day:string)=>void}) {
  const [query,setQuery] = useState('');
  const [selected,setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const tokens = query.trim().toLowerCase().split(/\s+/);
  const matches = commands.filter(command=>tokens.every(token=>`${command.title} ${command.keywords??''}`.toLowerCase().includes(token)));
  if (parseDay(query.trim())) matches.unshift({id:'date',title:`Open ${longDate(query.trim())}`,subtitle:query.trim(),run:()=>onDate(query.trim())});
  useEffect(()=>{input.current?.focus();},[]);
  useEffect(()=>{setSelected(0);},[query]);
  const run = (command:Command) => {onClose();command.run();};
  return <div className="overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className="palette" role="dialog" aria-modal="true" aria-label="Commands" onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();onClose();}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setSelected(index=>(index+(event.key==='ArrowDown'?1:-1)+matches.length)%Math.max(1,matches.length));}
      if(event.key==='Enter'&&matches[selected]){event.preventDefault();run(matches[selected]);}
      if(event.key==='Tab'){event.preventDefault();input.current?.focus();}
    }}>
      <input ref={input} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search commands or enter YYYY-MM-DD" aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={matches[selected]?`command-${matches[selected].id}`:undefined}/>
      <div className="command-results" id="command-results" role="listbox">
        {matches.map((command,index)=><button key={command.id} id={`command-${command.id}`} role="option" aria-selected={index===selected} className={index===selected?'selected':''} onMouseMove={()=>setSelected(index)} onClick={()=>run(command)} tabIndex={-1}>
          <span>{command.title}{command.subtitle&&<small>{command.subtitle}</small>}</span>{command.shortcut&&<kbd>{command.shortcut}</kbd>}
        </button>)}
        {!matches.length&&<p className="empty-results">No matching commands</p>}
      </div>
      <footer><span>↑↓ Navigate</span><span>↵ Run</span><span>esc Close</span></footer>
    </section>
  </div>;
}
