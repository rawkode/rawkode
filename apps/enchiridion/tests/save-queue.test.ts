import {describe,it,expect,vi} from 'vitest';
import {SaveQueue} from '../src/save-queue';
const day={day:'2026-09-08',token:'lease',revision:0,snapshot:null,legacy:null};
describe('durable editor save queue',()=>{
  it('serializes writes, coalesces queued edits and uses acknowledged revisions',async()=>{
    let release:()=>void=()=>{};
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const writer=vi.fn(async(request)=>{if(request.sequence===1)await blocked;return{sequence:request.sequence,revision:request.baseRevision+1};});
    const queue=new SaveQueue(day,writer,()=>{});
    queue.enqueue(new Uint8Array([1]));queue.enqueue(new Uint8Array([2]));queue.enqueue(new Uint8Array([3]));
    expect(writer).toHaveBeenCalledTimes(1);release();await queue.flush();
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer.mock.calls[1][0]).toMatchObject({snapshot:[3],baseRevision:1,sequence:2});
    expect(queue.dirty).toBe(false);
  });
  it('retains the latest draft after write failure and retries before navigation',async()=>{
    let fail=true;
    const writer=vi.fn(async(request)=>{if(fail)throw new Error('disk full');return{sequence:request.sequence,revision:1};});
    const queue=new SaveQueue(day,writer,()=>{});
    queue.enqueue(new Uint8Array([1]));queue.enqueue(new Uint8Array([2]));
    await expect(queue.flush()).rejects.toThrow('disk full');expect(queue.dirty).toBe(true);
    fail=false;await queue.flush();
    expect(writer.mock.lastCall?.[0].snapshot).toEqual([2]);expect(queue.dirty).toBe(false);
  });
  it('does not create a note from viewing an empty day',async()=>{
    const writer=vi.fn();const queue=new SaveQueue(day,writer,()=>{});await queue.flush();expect(writer).not.toHaveBeenCalled();
  });
  it('retries the exact committed request after a lost acknowledgement before saving newer edits',async()=>{
    let revision=0;
    let savedSequence=0;
    let savedSnapshot:number[]=[];
    let diskWrites=0;
    let loseFirstReceipt=true;
    const writer=vi.fn(async(request)=>{
      // Match the Rust store: an exact committed retry receives its old receipt,
      // even though that request necessarily contains the old base revision.
      if(request.sequence===savedSequence&&JSON.stringify(request.snapshot)===JSON.stringify(savedSnapshot)){
        return{sequence:savedSequence,revision};
      }
      if(request.baseRevision!==revision)throw new Error('stale base revision');
      expect(request.sequence).toBeGreaterThan(savedSequence);
      savedSequence=request.sequence;
      savedSnapshot=[...request.snapshot];
      revision++;diskWrites++;
      if(loseFirstReceipt){loseFirstReceipt=false;throw new Error('IPC reply was lost after commit');}
      return{sequence:savedSequence,revision};
    });
    const queue=new SaveQueue(day,writer,()=>{});
    queue.enqueue(new Uint8Array([1]));
    queue.enqueue(new Uint8Array([2]));
    await queue.flush();
    expect(writer).toHaveBeenCalledTimes(3);
    expect(writer.mock.calls[1][0]).toEqual(writer.mock.calls[0][0]);
    expect(writer.mock.calls[1][0]).toMatchObject({sequence:1,baseRevision:0,snapshot:[1]});
    expect(writer.mock.calls[2][0]).toMatchObject({sequence:2,baseRevision:1,snapshot:[2]});
    expect(savedSnapshot).toEqual([2]);
    expect(diskWrites).toBe(2);
    expect(queue.acknowledgedSequence).toBe(2);
    expect(queue.error).toBeNull();
    expect(queue.dirty).toBe(false);
  });

});
