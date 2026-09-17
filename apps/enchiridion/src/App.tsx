import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {listen} from '@tauri-apps/api/event';
import {createDailyEditor} from './editor';
import type {DailyEditorHandle,DiagramKind} from './editor/types';
import {CommandPalette,type Command} from './CommandPalette';
import {SettingsDialog} from './SettingsDialog';
import {LinkDialog} from './LinkDialog';
import {dayID,longDate,offsetDay,parseDay} from './dates';
import {finishQuit,loadDay,loadPreview,storePreview,writeSnapshot} from './native';
import {SaveQueue} from './save-queue';
const DiagramDialog=lazy(()=>import('./diagrams/DiagramDialog'));
type DiagramRequest={kind:DiagramKind;source:string;id?:string;handle:DailyEditorHandle};
type Selection={empty:boolean;rect:DOMRect|null;formats:string[]};

export default function App() {
  const host=useRef<HTMLDivElement>(null);
  const handle=useRef<DailyEditorHandle|null>(null);
  const queue=useRef<SaveQueue|null>(null);
  const navigating=useRef(false);
  const quitting=useRef(false);
  const [day,setDay]=useState(dayID());
  const [busy,setBusy]=useState(true);
  const [busyLabel,setBusyLabel]=useState("Opening note…");
  const [error,setError]=useState<string|null>(null);
  const [,refresh]=useState(0);
  const [palette,setPalette]=useState(false);
  const [settings,setSettings]=useState(false);
  const [link,setLink]=useState<string|null>(null);
  const [diagram,setDiagram]=useState<DiagramRequest|null>(null);
  const [selection,setSelection]=useState<Selection>({empty:true,rect:null,formats:[]});
  const state=useRef({day,palette,settings,diagram,link});
  state.current={day,palette,settings,diagram,link};

  async function navigate(next:string) {
    if(quitting.current||navigating.current||state.current.diagram||state.current.settings||state.current.link!==null)return;
    if(handle.current&&next===state.current.day){handle.current.editor.commands.focus();return;}
    navigating.current=true;setBusyLabel("Opening note…");setBusy(true);
    let frozen=false;
    try {
      handle.current?.prepareForTransition();
      frozen=true;
      await Promise.resolve();
      await queue.current?.flush();
      const loaded=await loadDay(next);
      handle.current?.destroy();handle.current=null;
      host.current!.replaceChildren();
      setDay(next);setError(null);setSelection({empty:true,rect:null,formats:[]});
      const saves=new SaveQueue(loaded,writeSnapshot,()=>refresh(value=>value+1));
      queue.current=saves;
      const editor=createDailyEditor({element:host.current!,day:next,
        snapshot:loaded.snapshot?new Uint8Array(loaded.snapshot):null,
        legacy:loaded.legacy?new Uint8Array(loaded.legacy):null,
        onChange:snapshot=>saves.enqueue(snapshot),
        onDiagramEdit:request=>{if(handle.current)setDiagram({...request,handle:handle.current});},
        loadPreview,
        onSelection:setSelection});
      handle.current=editor;
      await editor.ready;
      editor.editor.commands.focus('end');
    }catch(error){setError(String(error));}
    finally{setBusy(false);navigating.current=false;if(frozen&&handle.current)handle.current.editor.setEditable(true,false);}
  }

  const execute=useRef<(action:string)=>void>(()=>{});
  execute.current=(action:string)=>{
    if(quitting.current)return;
    if(action==='flush-and-quit'){
      if(navigating.current){setError('Please wait for the note to open, then quit again.');return;}
      if(state.current.diagram||state.current.settings||state.current.link!==null){window.dispatchEvent(new Event('enchiridion-quit-requested'));return;}
      quitting.current=true;setBusyLabel('Saving changes…');setBusy(true);
      void (async()=>{let frozen=false;try{handle.current?.prepareForTransition();frozen=true;await Promise.resolve();await queue.current?.flush();await finishQuit(queue.current?.day.token??null,queue.current?.acknowledgedSequence??0);}catch(error){setError(String(error));quitting.current=false;setBusy(false);if(frozen)handle.current?.editor.setEditable(true,false);}})();return;
    }
    if(navigating.current||state.current.diagram||state.current.settings||state.current.link!==null)return;
    if(action==='show-commands'){setPalette(value=>!value);return;}
    if(action==='settings'){setPalette(false);setSettings(true);return;}
    if(action==='today'){void navigate(dayID());return;}
    if(action==='previous-day'||action==='next-day'){void navigate(offsetDay(state.current.day,action==='next-day'?1:-1));return;}
    const editor=handle.current?.editor;
    if(!editor||busy)return;
    const chain=editor.chain().focus();
    switch(action){
      case 'undo':chain.undo().run();break;
      case 'redo':chain.redo().run();break;
      case 'bold':chain.toggleBold().run();break;
      case 'italic':chain.toggleItalic().run();break;
      case 'underline':chain.toggleUnderline().run();break;
      case 'strikethrough':chain.toggleStrike().run();break;
      case 'bullet':chain.toggleBulletList().run();break;
      case 'numbered':chain.toggleOrderedList().run();break;
      case 'checklist':chain.toggleTaskList().run();break;
      case 'paragraph':chain.setParagraph().run();break;
      case 'heading':chain.toggleHeading({level:2}).run();break;
      case 'quote':chain.toggleBlockquote().run();break;
      case 'code':chain.toggleCodeBlock().run();break;
      case 'table':chain.insertTable({rows:3,cols:3,withHeaderRow:true}).run();break;
      case 'd2':case 'excalidraw':setDiagram({kind:action,source:'',handle:handle.current!});break;
      case 'link':setLink(editor.getAttributes('link').href??'');break;
    }
  };

  useEffect(()=>{
    void navigate(dayID());
    const unlisten=listen<string>('app-command',event=>execute.current(event.payload));
    const keydown=(event:KeyboardEvent)=>{
      if(document.querySelector('dialog[open]'))return;
      const modifier=event.metaKey||event.ctrlKey;
      if(!modifier)return;
      let action:string|undefined;
      if(event.key.toLowerCase()==='k')action='show-commands';
      else if(event.key===',')action='settings';
      else if(event.shiftKey&&event.key.toLowerCase()==='t')action='today';
      else if(event.altKey&&event.key==='ArrowLeft')action='previous-day';
      else if(event.altKey&&event.key==='ArrowRight')action='next-day';
      if(action){event.preventDefault();execute.current(action);}
    };
    window.addEventListener('keydown',keydown);
    const unload=(event:BeforeUnloadEvent)=>{if(queue.current?.dirty){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',unload);
    return()=>{void unlisten.then(fn=>fn());window.removeEventListener('keydown',keydown);window.removeEventListener('beforeunload',unload);handle.current?.destroy();};
  },[]);

  const command=(id:string,title:string,shortcut?:string,keywords?:string):Command=>({id,title,shortcut,keywords,run:()=>execute.current(id)});
  const commands=[
    command('today','Go to Today','⇧⌘T'),command('previous-day','Previous Day','⌥⌘←'),command('next-day','Next Day','⌥⌘→'),
    command('bullet','Bulleted List','', 'unordered'),command('numbered','Numbered List','', 'ordered'),command('checklist','Checklist','', 'todo task'),
    command('paragraph','Paragraph'),command('heading','Heading'),command('quote','Quote'),command('code','Code Block'),command('table','Insert Table'),
    command('d2','Insert D2 Diagram','', 'TALA chart'),command('excalidraw','Insert Drawing','', 'Excalidraw sketch'),
    command('bold','Bold','⌘B'),command('italic','Italic','⌘I'),command('underline','Underline','⌘U'),command('strikethrough','Strikethrough','⇧⌘X'),command('link','Add Link'),
    command('settings','Settings','⌘,')];
  const closePalette=()=>{setPalette(false);requestAnimationFrame(()=>{if(!state.current.settings&&!state.current.diagram)handle.current?.editor.commands.focus();});};
  const saveError=queue.current?.error;
  return <main className="app">
    <header className="day-header"><div><h1>{day===dayID()?'Today':parseDay(day)!.toLocaleDateString(undefined,{weekday:'long'})}</h1><p>{longDate(day)}</p></div>
      <button className="command-trigger" aria-label="Open commands" title="Commands (⌘K)" onClick={()=>setPalette(true)}>⌘ K</button>
    </header>
    <div className="document-region" aria-busy={busy} {...((palette||settings||link!==null||diagram!==null||busy)?{inert:''}:{})}>
      <div ref={host} className="editor-host"/>
    </div>
    {busy&&<div className="loading-note" role="status">{busyLabel}</div>}
    {(error||saveError)&&<div className="save-error" role="alert"><span>{error||saveError}</span><button onClick={()=>{void queue.current?.flush().then(()=>setError(null)).catch(error=>setError(String(error)));}}>Retry save</button></div>}
    {!palette&&!settings&&link===null&&!diagram&&!busy&&!selection.empty&&selection.rect&&<div role="toolbar" aria-label="Selection formatting" className="format-bar" style={{left:Math.min(Math.max(selection.rect.x+selection.rect.width/2,100),window.innerWidth-100),top:selection.rect.top>65?selection.rect.top-48:selection.rect.bottom+8}} onMouseDown={event=>event.preventDefault()}>
      {(['bold','italic','underline','strikethrough'] as const).map((format,index)=><button key={format} title={format} aria-label={format} aria-pressed={selection.formats.includes(format==='strikethrough'?'strike':format)} onClick={()=>execute.current(format)}><span className={format}>{['B','I','U','S'][index]}</span></button>)}
      <button aria-label="Add link" title="Link" onClick={()=>execute.current('link')}>↗</button>
    </div>}
    {palette&&<CommandPalette commands={commands} onClose={closePalette} onDate={day=>{void navigate(day);}}/>}
    {link!==null&&<LinkDialog initial={link} onClose={()=>{setLink(null);handle.current?.editor.commands.focus();}} onSave={url=>{
      const chain=handle.current?.editor.chain().focus().extendMarkRange('link');
      if(url)chain?.setLink({href:url}).run();else chain?.unsetLink().run();setLink(null);
    }}/>}
    {settings&&<SettingsDialog onClose={()=>{setSettings(false);handle.current?.editor.commands.focus();}}/>}
    {diagram&&<Suspense fallback={<div className="overlay"><div className="loading-dialog">Opening diagram editor…<button onClick={()=>setDiagram(null)}>Cancel</button></div></div>}><DiagramDialog kind={diagram.kind} source={diagram.source} onCancel={()=>setDiagram(null)} onSave={async({source,previewDataURL})=>{
      if(handle.current!==diagram.handle)throw new Error('This note is no longer open.');
      if(!diagram.id){
        const empty=diagram.kind==='d2'?!source.trim():(JSON.parse(source).elements??[]).every((element:{isDeleted?:boolean})=>element.isDeleted);
        if(empty){setDiagram(null);return;}
      }
      await storePreview(diagram.kind,source,previewDataURL).catch(()=>{});
      if(diagram.id)diagram.handle.updateDiagram(diagram.id,diagram.source,source);
      else diagram.id=diagram.handle.insertDiagram(diagram.kind,source);
      diagram.source=source;
      await Promise.resolve(); // Allow the Loro transaction notification to enqueue its snapshot.
      await queue.current?.flush();
      setDiagram(null);diagram.handle.editor.commands.focus();
    }}/></Suspense>}
  </main>;
}
