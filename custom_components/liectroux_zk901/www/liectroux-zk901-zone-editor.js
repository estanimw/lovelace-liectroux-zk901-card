const TAG = "liectroux-zk901-zone-editor";
const GET = "liectroux_zk901/zone_editor/get";
const APPLY = "liectroux_zk901/zone_editor/apply";
const T = {
  es: {
    title:"Editor visual de zonas", reload:"Recargar", fit:"Ajustar", create:"Crear zona",
    ageUnknown:"antigüedad desconocida",
    newName:"Nueva zona",
    cancel:"Cancelar creación", move:"Mover zona", select:"Seleccionar", name:"Nombre",
    type:"Tipo", normal:"Normal", depth:"Profunda", forbid:"Prohibida",
    add:"Añadir vértice", remove:"Quitar vértice seleccionado", delete:"Eliminar zona",
    undo:"Deshacer", discard:"Descartar", save:"Guardar", noSelection:"Selecciona una zona o crea una nueva.",
    loading:"Cargando zonas…", empty:"Todavía no hay zonas guardadas.",
    emptyHelp:"Elige el ancho visible. Sin pose, confirma el origen antes de dibujar.",
    grid:"Ancho visible (unidades del protocolo)", origin:"Usar origen 0,0",
    originReady:"Origen 0,0 confirmado. Arrastra para dibujar un rectángulo.",
    drag:"Arrastra en el plano para dibujar un rectángulo.",
    dirty:"Cambios locales pendientes; todavía no se enviaron al robot.",
    localDraft:"Borrador local conservado aparte del catálogo actual.",
    copyDraft:"Datos del borrador local",
    smallRectangle:"El rectángulo es demasiado pequeño; arrastra una distancia mayor.",
    deleting:"La zona se eliminará al guardar.", saving:"Guardando y verificando…",
    saved:"Zona guardada y confirmada.", created:"Zona creada y confirmada.",
    deleted:"Zona eliminada y confirmada.", conflict:"El catálogo cambió. Se conserva el borrador, pero no se puede guardar sobre la versión nueva.",
    uncertain:"No se pudo confirmar el resultado. No reenvíes el borrador; recarga el catálogo.",
    invalid:"Revisa el borrador: ", unavailable:"No se pudo comunicar con la aspiradora. Recarga antes de continuar.",
    rejected:"La aspiradora rechazó la operación: ",
    notFound:"No se encontró una aspiradora Liectroux cargada para esta entidad.",
    error:"No se pudo completar la operación.", pose:"Posición del robot",
    units:"Coordenadas del protocolo; su equivalencia exacta con milímetros sigue inferida.", discardConfirm:"¿Descartar el borrador y cambiar de zona?",
    confirmDelete:"¿Eliminar esta zona? El cambio se enviará al pulsar Guardar.",
    noChanges:"No hay cambios para guardar.", createSummary:"Crear zona nueva",
    deleteSummary:"Eliminar zona", editSummary:"Guardar cambios: ", nameChange:"nombre",
    typeChange:"tipo", geometry:"geometría", vertex:"Vértice"
  },
  en: {
    title:"Visual zone editor", reload:"Reload", fit:"Fit view", create:"Create zone",
    ageUnknown:"age unknown",
    newName:"New zone",
    cancel:"Cancel creation", move:"Move zone", select:"Select", name:"Name",
    type:"Type", normal:"Normal", depth:"Deep clean", forbid:"Forbidden",
    add:"Add vertex", remove:"Remove selected vertex", delete:"Delete zone",
    undo:"Undo", discard:"Discard", save:"Save", noSelection:"Select a zone or create one.",
    loading:"Loading zones…", empty:"There are no saved zones yet.",
    emptyHelp:"Choose the visible width. Without a robot pose, confirm the origin before drawing.",
    grid:"Visible width (protocol units)", origin:"Use origin 0,0",
    originReady:"Origin 0,0 confirmed. Drag to draw a rectangle.",
    drag:"Drag on the canvas to draw a rectangle.",
    dirty:"Local changes are pending; nothing has been sent to the robot.",
    localDraft:"The local draft is preserved separately from the current catalog.",
    copyDraft:"Local draft data",
    smallRectangle:"The rectangle is too small; drag a larger distance.",
    deleting:"This zone will be deleted when you save.", saving:"Saving and verifying…",
    saved:"Zone saved and confirmed.", created:"Zone created and confirmed.",
    deleted:"Zone deleted and confirmed.", conflict:"The catalog changed. Your draft is preserved, but cannot be saved over the new version.",
    uncertain:"The result could not be confirmed. Do not resend the draft; reload the catalog.",
    invalid:"Review the draft: ", unavailable:"Could not contact the vacuum. Reload before continuing.",
    rejected:"The vacuum rejected the operation: ",
    notFound:"No loaded Liectroux vacuum was found for this entity.",
    error:"The operation could not be completed.", pose:"Robot position",
    units:"Protocol coordinates; their exact equivalence to millimeters remains inferred.", discardConfirm:"Discard the draft and switch zones?",
    confirmDelete:"Delete this zone? The change will be sent when you press Save.",
    noChanges:"There are no changes to save.", createSummary:"Create new zone",
    deleteSummary:"Delete zone", editSummary:"Save changes: ", nameChange:"name",
    typeChange:"type", geometry:"geometry", vertex:"Vertex"
  }
};
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);

class ZoneEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode:"open"});
    this._config=null; this._hass=null; this._catalog=null; this._pose=null;
    this._selected=null; this._draft=null; this._op=null; this._undo=[];
    this._vertex=null; this._creating=false; this._moving=false; this._origin=false;
    this._span=5000; this._view=null; this._drag=null; this._busy=false;
    this._conflict=false; this._uncertain=false; this._loading=false;
    this._conflictDraft=null;
    this._message=""; this._kind="info";
  }
  setConfig(config) {
    if (!config || typeof config.entity!=="string" || !config.entity.startsWith("vacuum."))
      throw new Error("Set entity to a Liectroux ZK901 vacuum entity_id");
    if(this._config&&this._config.entity!==config.entity){
      this._catalog=null;this._pose=null;this._selected=null;this._draft=null;this._op=null;
      this._undo=[];this._conflict=false;this._uncertain=false;this._conflictDraft=null;
      this._origin=false;this._moving=false;this._creating=false;this._view=null;this._message="";
    }
    this._config={entity:config.entity}; this._loading=false; this._loadedEntity=null; this._render();
    if (this._hass) this._load();
  }
  getCardSize() { return 14; }
  set hass(value) { this._hass=value; if (value&&this._config&&!this._loading&&this._loadedEntity!==this._config.entity) this._load(); }
  get hass() { return this._hass; }
  connectedCallback() {
    this._render(); if (this._hass&&this._config) this._load();
    if(!this._ageTimer)this._ageTimer=setInterval(()=>this._updatePoseAge(),10000);
  }
  disconnectedCallback() { if(this._ageTimer){clearInterval(this._ageTimer);this._ageTimer=null;} }
  _updatePoseAge() {
    const label=this.shadowRoot.querySelector(".pose-time");
    if(label&&this._pose&&Array.isArray(this._pose.pos))label.textContent=this._t().pose+": "+this._pose.pos.join(", ")+" · "+this._age(this._pose.observed_at);
  }
  _t() {
    const lang=(this._hass&&this._hass.language)||navigator.language||"en";
    return lang.toLowerCase().startsWith("es")?T.es:T.en;
  }
  async _load(force=false) {
    if (!this._hass||!this._config||this._busy||this._loading||(!force&&this._loadedEntity===this._config.entity)) return;
    if(force&&this._dirty()&&!this._conflict&&!this._uncertain&&!window.confirm(this._t().discardConfirm))return;
    const entity=this._config.entity,hass=this._hass;
    this._loading=true; this._busy=true; this._message=this._t().loading; this._kind="info"; this._render();
    try {
      const response=await hass.connection.sendMessagePromise({type:GET,entity_id:entity});
      if(!this._config||this._config.entity!==entity)return;
      const result=response&&response.result?response.result:response;
      if (!result||!result.ok) { this._setError(result&&result.error); return; }
      this._accept(result); this._conflict=false; this._uncertain=false; this._conflictDraft=null; this._op=null; this._undo=[];
      this._draft=this._selected==null?null:clone(this._area(this._selected)); this._message="";
    } catch (_) { if(this._config&&this._config.entity===entity){this._message=this._t().unavailable; this._kind="error";} }
    finally {
      if(this._config&&this._config.entity===entity)this._loadedEntity=entity;
      this._loading=false; this._busy=false; this._render();
      if(this._config&&this._config.entity!==entity)this._load();
    }
  }
  _accept(result) {
    this._catalog={map_id:result.map_id,revision:result.revision,areas:clone(result.areas||[]),observed_at:result.observed_at};
    this._pose=clone(result.pose);
    if (!this._editableAreas().some((a)=>a.id===this._selected)) { this._selected=null; this._draft=null; }
    this._fit();
  }
  _setError(error) {
    const t=this._t(), map={not_found:t.notFound,unavailable:t.unavailable,invalid_catalog:t.error};
    this._message=map[error]||t.error; this._kind="error";
  }
  _age(observedAt) {
    const time=Date.parse(observedAt||""),seconds=Math.max(0,Math.floor((Date.now()-time)/1000));
    if(!Number.isFinite(seconds))return this._t().ageUnknown;
    if(this._t()===T.es)return seconds<60?"hace "+seconds+" s":"hace "+Math.floor(seconds/60)+" min";
    return seconds<60?seconds+"s ago":Math.floor(seconds/60)+"m ago";
  }
  _editableAreas() { return this._catalog&&Array.isArray(this._catalog.areas)?this._catalog.areas.filter((a)=>a&&typeof a==="object"&&Number.isSafeInteger(a.id)&&a.id>0):[]; }
  _area(id) { return this._editableAreas().find((a)=>a.id===id)||null; }
  _pushUndo() {
    this._undo.push({selected:this._selected,draft:clone(this._draft),op:this._op,creating:this._creating});
    if (this._undo.length>50) this._undo.shift();
  }
  _undoEdit() {
    const x=this._undo.pop(); if (!x) return;
    this._selected=x.selected; this._draft=x.draft; this._op=x.op; this._creating=x.creating;
    this._vertex=null; this._message=""; this._render();
  }
  _discard() {
    if (this._op==="create") { this._selected=null; this._draft=null; }
    else this._draft=clone(this._area(this._selected));
    this._op=null; this._creating=false; this._vertex=null; this._undo=[]; this._message=""; this._render();
  }
  _dirty() {
    if (this._op==="create") return !!(this._draft&&Array.isArray(this._draft.vertexs));
    if (this._op==="delete") return true;
    const a=this._area(this._selected);
    return !!(a&&this._draft&&["tag","active","vertexs"].some((k)=>!equal(a[k],this._draft[k])));
  }
  _fields() {
    if (this._op==="create") return ["tag","active","vertexs"];
    const a=this._area(this._selected);
    if (!a||!this._draft||this._op==="delete") return [];
    return ["tag","active","vertexs"].filter((k)=>!equal(a[k],this._draft[k]));
  }
  _field(key,value) {
    if (!this._draft||this._busy||this._op==="delete") return;
    this._pushUndo(); this._draft[key]=value; this._message=""; this._updateDirtyUi();
  }
  _select(id) {
    if (this._op==="create") return false;
    if(id===this._selected)return this._op!=="delete";
    if (this._dirty()&&id!==this._selected&&!window.confirm(this._t().discardConfirm)) { this._render(); return false; }
    this._selected=id; this._draft=clone(this._area(id)); this._op=null;
    this._vertex=null; this._moving=false; this._undo=[]; this._message=""; this._render(); return true;
  }
  _startCreate() {
    if (!this._catalog||this._busy||this._conflict||this._uncertain) return;
    if (this._dirty()&&!window.confirm(this._t().discardConfirm)) return;
    this._undo=[];
    this._pushUndo(); this._op="create"; this._creating=true; this._selected=null; this._draft=null;
    this._message=this._t().drag; this._kind="info"; this._render();
  }
  _delete() {
    if (!this._draft||this._op==="create"||this._busy||!window.confirm(this._t().confirmDelete)) return;
    this._pushUndo(); this._op="delete"; this._message=this._t().deleting; this._kind="info"; this._render();
  }
  _newRectangle(a,b) {
    const x0=Math.round(Math.min(a.x,b.x)),x1=Math.round(Math.max(a.x,b.x));
    const y0=Math.round(Math.min(a.y,b.y)),y1=Math.round(Math.max(a.y,b.y));
    if (x1-x0<2||y1-y0<2) { this._message=this._t().smallRectangle; this._kind="error"; this._render(); return; }
    this._draft={id:null,name:"",tag:this._t().newName,active:"normal",
      vertexs:[[x0,-y0],[x1,-y0],[x1,-y1],[x0,-y1]]};
    this._op="create"; this._creating=false; this._message=""; this._render();
  }
  _payload() {
    if(!this._draft)return null;
    if (this._op==="create") return {operation:"create",tag:this._draft.tag,active:this._draft.active,vertexs:this._draft.vertexs};
    if (this._op==="delete") return {operation:"delete",area_id:this._selected};
    const p={operation:"update",area_id:this._selected};
    for (const key of this._fields()) p[key]=this._draft[key];
    return p;
  }
  async _save() {
    const t=this._t();
    if (!this._catalog||!this._dirty()||this._busy||this._conflict||this._uncertain) {
      if (!this._dirty()) { this._message=t.noChanges; this._kind="info"; this._render(); }
      return;
    }
    const payload=this._payload();
    if(!payload)return;
    const entity=this._config.entity,hass=this._hass;
    if (payload.operation==="update"&&Object.keys(payload).length===2) return;
    this._busy=true; this._message=t.saving; this._kind="info"; this._render();
    try {
      const response=await hass.connection.sendMessagePromise({
        type:APPLY,entity_id:entity,base_map_id:this._catalog.map_id,
        base_revision:this._catalog.revision,...payload
      });
      if(!this._config||this._config.entity!==entity)return;
      const r=response&&response.result?response.result:response;
      if (r&&r.ok) {
        const op=r.operation,id=r.area_id; this._accept(r); this._selected=op==="delete"?null:id;
        this._draft=this._selected==null?null:clone(this._area(this._selected));
        this._op=null; this._creating=false; this._undo=[]; this._conflict=false; this._uncertain=false;
        this._message=op==="create"?t.created:op==="delete"?t.deleted:t.saved; this._kind="success";
      } else if (r&&r.error==="conflict") {
        this._conflictDraft={operation:this._op,area_id:this._selected,draft:clone(this._draft)};
        this._catalog={map_id:r.map_id,revision:r.revision,areas:clone(r.areas||[])};
        this._fit();
        this._conflict=true; this._message=t.conflict; this._kind="error";
      } else if (r&&r.error==="uncertain") {
        this._uncertain=true; this._message=t.uncertain; this._kind="error";
      } else if (r&&r.error==="invalid") {
        this._message=t.invalid+(r.detail||""); this._kind="error";
      } else if (r&&r.error==="rejected") {
        this._message=t.rejected+(r.detail||""); this._kind="error";
      } else this._setError(r&&r.error);
    } catch (_) {
      // A lost WebSocket response may follow a completed write. Read before retrying.
      if(this._config&&this._config.entity===entity){this._uncertain=true; this._message=t.uncertain; this._kind="error";}
    } finally {
      this._busy=false; this._render();
      if(this._config&&this._config.entity!==entity)this._load();
    }
  }
  _fit() {
    const areas=this._editableAreas();
    if (!areas.length&&!this._draft&&!this._conflictDraft) {
      const p=this._pose&&this._pose.pos&&this._pose.pos.length===2?this._pose.pos:[0,0];
      this._view={x:Number(p[0])-this._span/2,y:-Number(p[1])-this._span/2,width:this._span,height:this._span}; return;
    }
    const pts=[];
    for(const a of areas) for(const p of Array.isArray(a.vertexs)?a.vertexs:[]) if(Array.isArray(p)&&p.length===2&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1]))) pts.push([Number(p[0]),-Number(p[1])]);
    if(this._pose&&this._pose.pos&&this._pose.pos.length===2)pts.push([Number(this._pose.pos[0]),-Number(this._pose.pos[1])]);
    const draft=this._conflictDraft?this._conflictDraft.draft:this._draft;
    if(draft&&Array.isArray(draft.vertexs))for(const p of draft.vertexs)if(Array.isArray(p)&&p.length===2&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1])))pts.push([Number(p[0]),-Number(p[1])]);
    if(!pts.length){this._view={x:-this._span/2,y:-this._span/2,width:this._span,height:this._span};return;}
    const xs=pts.map((p)=>p[0]),ys=pts.map((p)=>p[1]),span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),500)*1.2;
    this._view={x:(Math.min(...xs)+Math.max(...xs)-span)/2,y:(Math.min(...ys)+Math.max(...ys)-span)/2,width:span,height:span};
  }
  _mapping(svg) {
    const rect=svg.getBoundingClientRect(),v=this._view;
    const scale=Math.min(rect.width/v.width,rect.height/v.height);
    const width=v.width*scale,height=v.height*scale;
    return {left:rect.left+(rect.width-width)/2,top:rect.top+(rect.height-height)/2,width,height};
  }
  _zoom(factor) {
    if(!this._view)this._fit();const v=this._view,w=Math.min(1e6,Math.max(100,v.width*factor)),h=v.height*w/v.width,cx=v.x+v.width/2,cy=v.y+v.height/2;
    this._view={x:cx-w/2,y:cy-h/2,width:w,height:h};this._draw();
  }
  _point(e,svg) {
    const r=this._mapping(svg),v=this._view;
    return {x:v.x+(e.clientX-r.left)/r.width*v.width,y:v.y+(e.clientY-r.top)/r.height*v.height};
  }
  _drawAreas() {
    const areas=clone(this._editableAreas());
    if(!this._conflict){
      if(this._op==="create"&&this._draft)areas.push({...this._draft,id:"new"});
      else if(this._draft&&this._op!=="delete"){const i=areas.findIndex((a)=>a.id===this._selected);if(i>=0)areas[i]=this._draft;}
    }
    return areas;
  }
  _draw() {
    const svg=this.shadowRoot.querySelector("svg.canvas");if(!svg||!this._view)return;
    const v=this._view;svg.setAttribute("viewBox",v.x+" "+v.y+" "+v.width+" "+v.height);
    const colors={normal:"#38a169",depth:"#3182ce",forbid:"#d64545"},group=svg.querySelector(".areas");if(!group)return;
    group.innerHTML=this._drawAreas().map((a)=>{
      const id=a.id==="new"?"new":esc(a.id),selected=id==="new"||a.id===this._selected,del=!this._conflict&&this._op==="delete"&&a.id===this._selected;
      const vertices=Array.isArray(a.vertexs)?a.vertexs:[];
      const pts=vertices.filter((p)=>Array.isArray(p)&&p.length===2&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1]))).map((p)=>Number(p[0])+","+(-Number(p[1]))).join(" ");
      const color=del?"#c53030":colors[a.active]||"#718096",label=esc(a.tag||a.name||("Zona "+id));
      const first=vertices.find((p)=>Array.isArray(p)&&p.length===2&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1])))||[0,0];
      return '<g class="zone" data-id="'+id+'" opacity="'+(del?0.45:1)+'"><polygon class="poly '+(selected?"selected":"")+'" points="'+pts+'" fill="'+color+'" fill-opacity=".18" stroke="'+color+'" stroke-width="3" vector-effect="non-scaling-stroke" tabindex="0" role="button" aria-label="'+label+'"></polygon><text class="label" x="'+Number(first[0])+'" y="'+(-Number(first[1]))+'">'+label+'</text></g>';
    }).join("");
    const handles=svg.querySelector(".handles");
    if(handles)handles.innerHTML=!this._conflict&&!this._uncertain&&this._draft&&this._op!=="delete"&&Array.isArray(this._draft.vertexs)?this._draft.vertexs.map((p,i)=>{
      if(!Array.isArray(p)||p.length!==2||!Number.isFinite(Number(p[0]))||!Number.isFinite(Number(p[1])))return "";
      return '<circle class="vertex '+(i===this._vertex?"chosen":"")+'" data-i="'+i+'" cx="'+Number(p[0])+'" cy="'+(-Number(p[1]))+'" r="'+Math.max(24,v.width/140)+'" tabindex="0" role="button" aria-label="'+this._t().vertex+" "+(i+1)+'"></circle>';
    }).join(""):"";
    const stale=svg.querySelector(".stale"),staleDraft=this._conflictDraft&&this._conflictDraft.draft;
    if(stale){
      const vertices=staleDraft&&Array.isArray(staleDraft.vertexs)?staleDraft.vertexs:[];
      const pts=vertices.filter((p)=>Array.isArray(p)&&p.length===2&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1]))).map((p)=>Number(p[0])+","+(-Number(p[1]))).join(" ");
      const color=this._conflictDraft&&this._conflictDraft.operation==="delete"?"#c53030":"#805ad5";
      const first=vertices.find((p)=>Array.isArray(p)&&p.length===2&&Number.isFinite(Number(p[0]))&&Number.isFinite(Number(p[1])))||[0,0];
      stale.innerHTML=this._conflict&&pts?'<polygon class="conflict-ghost" points="'+pts+'" stroke="'+color+'"></polygon><text class="label" x="'+Number(first[0])+'" y="'+(-Number(first[1]))+'">'+esc(this._t().localDraft)+'</text>':"";
    }
    const pose=svg.querySelector(".pose");
    if(pose&&this._pose&&this._pose.pos&&this._pose.pos.length===2){
      const x=Number(this._pose.pos[0]),y=-Number(this._pose.pos[1]),angle=Number.isFinite(Number(this._pose.phi))?-Number(this._pose.phi)/1000*180/Math.PI:0,len=Math.max(100,v.width/9);
      pose.innerHTML='<g transform="translate('+x+" "+y+") rotate("+angle+')"><circle r="'+Math.max(30,v.width/90)+'" class="robot"></circle><path d="M0 0 L0 '+(-len)+' M'+(-len*.22)+" "+(-len*.72)+" L0 "+(-len)+" L"+(len*.22)+" "+(-len*.72)+'" class="heading"></path></g>';
    } else if(pose)pose.innerHTML="";
  }
  _summary() {
    if(!this._draft)return "";
    const t=this._t();if(this._op==="create")return t.createSummary+": "+(this._draft.tag||t.newName)+" ("+(this._draft.active||t.normal)+")";
    if(this._op==="delete")return t.deleteSummary+" "+(this._draft.tag||("#"+this._selected));
    return t.editSummary+"#"+this._selected+" ("+(this._draft.tag||"")+"): "+this._fields().map((k)=>k==="tag"?t.nameChange:k==="active"?t.typeChange:t.geometry).join(", ");
  }
  _render() {
    if(!this.shadowRoot)return;
    const t=this._t(),areas=this._editableAreas(),selected=this._draft,dirty=this._dirty();
    const canMove=!!(selected&&Array.isArray(selected.vertexs)&&selected.vertexs.length>=3);
    const locked=this._busy||this._conflict||this._uncertain;
    const options=areas.map((a)=>'<option value="'+esc(a.id)+'" '+(a.id===this._selected?"selected":"")+'>'+esc(a.tag||a.name||("Zona "+a.id))+" ["+esc(a.id)+"]"+(a.active==="forbid"?" · "+t.forbid:"")+"</option>").join("");
    const empty=areas.length===0&&!selected?'<div class="empty"><b>'+t.empty+'</b><p>'+t.emptyHelp+'</p><label>'+t.grid+'<input id="span" type="number" min="1000" max="100000" step="500" value="'+this._span+'"></label>'+(!this._pose?'<button id="origin" '+(this._origin?"disabled":"")+'>'+t.origin+"</button>":"")+(this._origin?"<p>"+t.originReady+"</p>":"")+(this._pose?"<p>"+t.drag+"</p>":"")+"</div>":"";
    let props='<div class="quiet">'+t.noSelection+"</div>";
    if(selected&&this._op==="delete")props='<p class="notice">'+t.deleting+"</p>";
    else if(selected)props='<label>'+t.name+'<input id="tag" maxlength="80" value="'+esc(selected.tag||selected.name||"")+'" '+(locked?"disabled":"")+'></label><label>'+t.type+'<select id="active" '+(locked?"disabled":"")+'><option value="normal" '+(selected.active==="normal"?"selected":"")+'>'+t.normal+'</option><option value="depth" '+(selected.active==="depth"?"selected":"")+'>'+t.depth+'</option><option value="forbid" '+(selected.active==="forbid"?"selected":"")+'>'+t.forbid+'</option></select></label><div class="pair"><button id="add" '+(locked||(Array.isArray(selected.vertexs)?selected.vertexs.length:0)>=128?"disabled":"")+'>'+t.add+'</button><button id="remove" '+(locked||this._vertex==null||(Array.isArray(selected.vertexs)?selected.vertexs.length:0)<=3?"disabled":"")+'>'+t.remove+'</button></div>'+(this._op!=="create"?'<button id="delete" class="danger" '+(locked?"disabled":"")+'>'+t.delete+"</button>":"");
    const style='<style>:host{display:block;color:var(--primary-text-color);font-family:Arial,sans-serif}*{box-sizing:border-box}ha-card{padding:16px;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;gap:10px}h2{font-size:18px;margin:0}button,input,select{font:inherit;color:inherit}button{border:1px solid var(--divider-color);background:var(--secondary-background-color);border-radius:6px;padding:8px 10px;cursor:pointer}button:disabled{opacity:.48;cursor:default}.toolbar,.actions{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.active{border-color:var(--primary-color);color:var(--primary-color)}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,280px);gap:14px}.canvas-wrap{position:relative;height:min(58vh,620px);min-height:300px;border:1px solid var(--divider-color);border-radius:8px;overflow:hidden;background:var(--secondary-background-color)}svg.canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}svg.canvas:active{cursor:grabbing}.poly{cursor:pointer;vector-effect:non-scaling-stroke}.poly.selected{stroke-width:3!important;stroke-dasharray:6 3}.conflict-ghost{fill:rgba(128,90,213,.08);stroke-width:5;stroke-dasharray:12 8;vector-effect:non-scaling-stroke;pointer-events:none}.label{font:bold 120px Arial;fill:var(--primary-text-color);paint-order:stroke;stroke:var(--card-background-color);stroke-width:24px;pointer-events:none}.vertex{fill:var(--primary-color);stroke:var(--card-background-color);stroke-width:4;vector-effect:non-scaling-stroke;cursor:move}.vertex.chosen{fill:#ffb300}.robot{fill:var(--primary-color);stroke:var(--card-background-color);stroke-width:5;vector-effect:non-scaling-stroke}.heading{fill:none;stroke:var(--primary-color);stroke-width:12;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.preview{fill:var(--primary-color);fill-opacity:.15;stroke:var(--primary-color);stroke-width:2;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}.side{display:flex;flex-direction:column;gap:10px}.side label,.empty label{display:flex;flex-direction:column;gap:5px;font-size:13px}.side input,.side select,.empty input{padding:8px;border:1px solid var(--divider-color);background:var(--card-background-color);border-radius:5px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:6px}.danger{color:var(--error-color,#b3261e)}.msg{padding:8px 10px;border-radius:6px;margin:8px 0;font-size:13px;background:var(--secondary-background-color)}.msg.error,.notice{background:rgba(190,35,35,.12);color:var(--error-color,#b3261e)}.msg.success{background:rgba(40,140,70,.14)}.empty{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(360px,90%);padding:16px;background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:8px;display:flex;flex-direction:column;gap:8px;font-size:13px;box-shadow:var(--ha-card-box-shadow)}.empty p{margin:0}.quiet,.help{font-size:12px;color:var(--secondary-text-color)}.summary{font-size:13px;padding:8px;background:var(--secondary-background-color);border-radius:5px}.draft-data{overflow:auto;max-height:180px;white-space:pre-wrap;word-break:break-word;font-size:11px}.full{grid-column:1/-1}.pose-time{font-size:12px;color:var(--secondary-text-color);margin-top:5px}@media(max-width:700px){.layout{grid-template-columns:1fr}.canvas-wrap{height:48vh;min-height:260px}.side{display:grid;grid-template-columns:1fr 1fr}.side .full{grid-column:1/-1}}</style>';
    const message=this._message?'<div class="msg '+this._kind+'" role="status">'+esc(this._message)+"</div>":"";
    let body='<div class="msg">'+esc(this._message||t.loading)+"</div>";
    if(this._catalog){
      const createActive=this._op==="create";
      const toolbar='<div class="toolbar"><button id="fit">'+t.fit+'</button><button id="zin" aria-label="Zoom in">＋</button><button id="zout" aria-label="Zoom out">−</button><button id="create" class="'+(createActive?"active":"")+'" '+(locked?"disabled":"")+'>'+(createActive?t.cancel:t.create)+'</button>'+(canMove&&this._op!=="create"&&this._op!=="delete"?'<button id="move" class="'+(this._moving?"active":"")+'" '+(locked?"disabled":"")+'>'+(this._moving?t.select:t.move)+"</button>":"")+"</div>";
      const svg='<svg class="canvas" viewBox="0 0 5000 5000" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="grid" width="500" height="500" patternUnits="userSpaceOnUse"><path d="M 500 0 L 0 0 0 500" fill="none" stroke="var(--divider-color)" stroke-width="3"/></pattern></defs><rect x="-1000000" y="-1000000" width="2000000" height="2000000" fill="url(#grid)" pointer-events="none"></rect><g class="areas"></g><g class="stale"></g><g class="handles"></g><g class="pose"></g></svg>';
      const pose=this._pose&&this._pose.pos?'<div class="pose-time">'+t.pose+": "+esc(this._pose.pos.join(", "))+" · "+esc(this._age(this._pose.observed_at))+"</div>":"";
      const panel=areas.length&&this._op!=="create"?'<label class="full">'+t.select+'<select id="area"><option value="">—</option>'+options+"</select></label>":"";
      const stale=this._conflictDraft?'<details class="full"><summary>'+t.copyDraft+'</summary><pre class="draft-data">'+esc(JSON.stringify({operation:this._conflictDraft.operation,area_id:this._conflictDraft.area_id,tag:this._conflictDraft.draft&&this._conflictDraft.draft.tag,active:this._conflictDraft.draft&&this._conflictDraft.draft.active,vertexs:this._conflictDraft.draft&&this._conflictDraft.draft.vertexs},null,2))+"</pre></details>":"";
      const summary='<div id="summary" class="summary full" '+(dirty?"":"hidden")+'>'+(dirty?esc(this._summary())+"<br>"+t.dirty:"")+"</div>";
      const actions='<div class="actions full"><button id="undo" '+(!this._undo.length||locked?"disabled":"")+'>'+t.undo+'</button><button id="discard" '+(!dirty||locked?"disabled":"")+'>'+t.discard+'</button><button id="save" '+(!dirty||locked?"disabled":"")+'>'+t.save+"</button></div>";
      body=toolbar+'<div class="layout"><div><div class="canvas-wrap">'+svg+empty+"</div><p class=\"help\">"+t.units+"</p>"+pose+"</div><div class=\"side\">"+panel+props+stale+summary+actions+"</div></div>";
    }
    this.shadowRoot.innerHTML=style+'<ha-card><header><h2>'+t.title+'</h2><button id="reload" '+(this._busy?"disabled":"")+'>'+t.reload+"</button></header>"+message+body+"</ha-card>";
    if(this._catalog){this._draw();this._bindCanvas();this._bindControls();}
  }
  _bindCanvas() {
    const svg=this.shadowRoot.querySelector("svg.canvas");if(!svg)return;
    svg.addEventListener("pointerdown",(e)=>{
      if(this._busy||this._conflict||this._uncertain)return;
      const handle=e.target.closest&&e.target.closest(".vertex"),poly=e.target.closest&&e.target.closest(".poly"),p=this._point(e,svg);
      if(handle&&this._draft&&this._op!=="delete"){this._pushUndo();this._vertex=Number(handle.dataset.i);this._drag={type:"vertex",index:this._vertex,original:clone(this._draft.vertexs[this._vertex])};}
      else if(this._op==="create"&&this._creating){if(!this._pose&&!this._editableAreas().length&&!this._origin)return;this._drag={type:"create",start:p};svg.setPointerCapture(e.pointerId);}
      else if(poly){const id=poly.closest(".zone").dataset.id;if(id==="new")return;const n=Number(id);if(n!==this._selected||!this._draft||this._op==="delete"){if(!this._select(n)||this._selected!==n)return;if(!this._moving)return;}if(this._moving&&this._draft&&this._op!=="delete"){this._pushUndo();this._drag={type:"move",start:p,original:clone(this._draft.vertexs)};}}
      else{this._drag={type:"pan",start:{x:e.clientX,y:e.clientY},original:{...this._view}};svg.setPointerCapture(e.pointerId);}
      if(this._drag&&this._drag.type!=="pan")svg.setPointerCapture(e.pointerId);e.preventDefault();
    });
    svg.addEventListener("keydown",(e)=>{
      const handle=e.target.closest&&e.target.closest(".vertex"),poly=e.target.closest&&e.target.closest(".poly");
      if(poly&&(e.key==="Enter"||e.key===" ")){e.preventDefault();const id=poly.closest(".zone").dataset.id;if(id!=="new")this._select(Number(id));return;}
      if(!handle||!this._draft||this._op==="delete")return;
      const delta=Math.max(1,Math.round(this._view.width/100));let dx=0,dy=0;
      if(e.key==="ArrowLeft")dx=-delta;else if(e.key==="ArrowRight")dx=delta;
      else if(e.key==="ArrowUp")dy=delta;else if(e.key==="ArrowDown")dy=-delta;else return;
      e.preventDefault();this._pushUndo();const index=Number(handle.dataset.i);this._vertex=index;
      this._draft.vertexs[index]=[this._draft.vertexs[index][0]+dx,this._draft.vertexs[index][1]+dy];
      this._render();this.shadowRoot.querySelector('.vertex[data-i="'+index+'"]')?.focus();
    });
    svg.addEventListener("pointermove",(e)=>{
      if(!this._drag)return;
      if(this._drag.type==="pan"){const r=this._mapping(svg),d=this._drag,o=d.original;if(r.width&&r.height)this._view={...o,x:o.x-(e.clientX-d.start.x)/r.width*o.width,y:o.y-(e.clientY-d.start.y)/r.height*o.height};}
      else{
        const p=this._point(e,svg);
        if(this._drag.type==="vertex")this._draft.vertexs[this._drag.index]=[Math.round(p.x),Math.round(-p.y)];
        if(this._drag.type==="move"){const d=this._drag,dx=p.x-d.start.x,dy=-(p.y-d.start.y);this._draft.vertexs=d.original.map(([x,y])=>[Math.round(x+dx),Math.round(y+dy)]);}
        if(this._drag.type==="create"){let r=svg.querySelector(".preview");if(!r){r=document.createElementNS("http://www.w3.org/2000/svg","rect");r.classList.add("preview");svg.append(r);}r.setAttribute("x",Math.min(this._drag.start.x,p.x));r.setAttribute("y",Math.min(this._drag.start.y,p.y));r.setAttribute("width",Math.abs(p.x-this._drag.start.x));r.setAttribute("height",Math.abs(p.y-this._drag.start.y));}
      }
      this._draw();
    });
    const finish=(e,cancelled=false)=>{if(!this._drag)return;const d=this._drag;this._drag=null;if(d.type==="create"&&!cancelled)this._newRectangle(d.start,this._point(e,svg));else if(d.type==="vertex"||d.type==="move"){if(cancelled){if(d.type==="vertex")this._draft.vertexs[d.index]=d.original;else this._draft.vertexs=d.original;this._undo.pop();}this._message="";this._render();}this.shadowRoot.querySelector(".preview")?.remove();};
    svg.addEventListener("pointerup",(e)=>finish(e));svg.addEventListener("pointercancel",(e)=>finish(e,true));
    svg.addEventListener("wheel",(e)=>{e.preventDefault();this._zoom(e.deltaY<0?.85:1.18);},{passive:false});
  }
  _bindControls() {
    const on=(q,event,fn)=>this.shadowRoot.querySelector(q)?.addEventListener(event,fn);
    on("#reload","click",()=>this._load(true));on("#fit","click",()=>{this._fit();this._draw();});
    on("#zin","click",()=>this._zoom(.8));on("#zout","click",()=>this._zoom(1.25));
    on("#create","click",()=>this._op==="create"?this._discard():this._startCreate());
    on("#move","click",()=>{this._moving=!this._moving;this._render();});
    on("#tag","change",(e)=>this._field("tag",e.target.value));on("#active","change",(e)=>this._field("active",e.target.value));
    on("#area","change",(e)=>{if(e.target.value!==""&&!this._select(Number(e.target.value)))this._render();});
    on("#undo","click",()=>this._undoEdit());on("#discard","click",()=>this._discard());on("#save","click",()=>this._save());
    on("#delete","click",()=>this._delete());on("#add","click",()=>this._addVertex());on("#remove","click",()=>this._removeVertex());
    on("#span","change",(e)=>{const n=Number(e.target.value);if(Number.isFinite(n)&&n>=1000&&n<=100000){this._span=Math.round(n);this._fit();this._render();}});
    on("#origin","click",()=>{this._origin=true;this._message=this._t().originReady;this._kind="info";this._render();});
  }
  _addVertex() {
    const p=this._draft&&this._draft.vertexs;if(!Array.isArray(p)||p.length<3||p.length>=128||this._op==="delete"||this._busy)return;
    if(!p.every((point)=>Array.isArray(point)&&point.length===2&&Number.isSafeInteger(point[0])&&Number.isSafeInteger(point[1])))return;
    let edge=0,best=-1;for(let i=0;i<p.length;i++){const n=(i+1)%p.length,dx=p[n][0]-p[i][0],dy=p[n][1]-p[i][1],d=dx*dx+dy*dy;if(d>best){best=d;edge=i;}}
    const n=(edge+1)%p.length;this._pushUndo();p.splice(edge+1,0,[Math.round((p[edge][0]+p[n][0])/2),Math.round((p[edge][1]+p[n][1])/2)]);this._vertex=edge+1;this._render();
  }
  _removeVertex() {
    if(!this._draft||!Array.isArray(this._draft.vertexs)||this._op==="delete"||this._busy||this._vertex==null||this._draft.vertexs.length<=3)return;
    this._pushUndo();this._draft.vertexs.splice(this._vertex,1);this._vertex=null;this._render();
  }
  _updateDirtyUi() {
    const dirty=this._dirty(),summary=this.shadowRoot.querySelector("#summary");
    const save=this.shadowRoot.querySelector("#save"),discard=this.shadowRoot.querySelector("#discard");
    if(summary){summary.hidden=!dirty;summary.textContent=dirty?this._summary()+"\n"+this._t().dirty:"";}
    if(save)save.disabled=!dirty||this._busy||this._conflict||this._uncertain;
    if(discard)discard.disabled=!dirty||this._busy||this._conflict||this._uncertain;
    if(!this._message)this.shadowRoot.querySelector("ha-card > .msg")?.remove();
  }
}
if(!customElements.get(TAG))customElements.define(TAG,ZoneEditor);
window.customCards=window.customCards||[];
if(!window.customCards.some((card)=>card.type===TAG))window.customCards.push({
  type:TAG,name:"Liectroux ZK901 Zone Editor",description:"View and edit saved cleaning zones.",preview:false
});
console.info("Liectroux ZK901 Zone Editor loaded");
