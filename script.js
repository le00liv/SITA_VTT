class SITA {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Canvas Auxiliar para Fog of War (Máscara)
        this.fogCanvas = document.createElement('canvas');
        this.fogCtx = this.fogCanvas.getContext('2d');

        // Estado Global (Sincronizado com Jogadores)
        this.state = {
            tokens: [],
            drawings: [],
            initiative: [],
            activeTurnIndex: 0,
            mapSrc: null, 
            fx: { rain: false, fog: false, vignette: false, grid: true, fire: false },
            fogEnabled: true,
            fogOpacity: 1.0, // 1.0 = Preto Total, 0.0 = Invisível
            gridSize: 50,
            bgPos: { x: 0, y: 0 },
            bgScale: 1
        };

        // Estado Local (Apenas Mestre)
        this.local = {
            tool: 'pan',
            drag: { active: false, start: {x:0, y:0} },
            mapImg: null,
            selectedTokenId: null,
            brush: { color: '#ff0000', size: 5, path: [] },
            ruler: { active: false, start: null, end: null },
            pings: [],
            showMaskOnDM: true,
            syncView: false,
            globalVolume: 0.5
        };

        this.channel = new BroadcastChannel('sita_channel');
        
        this.initDB();
        this.init();
    }

    init() {
        this.resize();
        window.onresize = () => this.resize();
        this.setupInputs();
        this.setupMouse();
        this.loadNotes();
        // Inicializar Fog como Preto Sólido
        this.resetFog(true); 
        this.loop();
    }

    resize() {
        this.canvas.width = this.canvas.parentElement.clientWidth;
        this.canvas.height = this.canvas.parentElement.clientHeight;
        // Fog Canvas grande para cobrir mapa
        this.fogCanvas.width = 4000;
        this.fogCanvas.height = 4000;
        // Redesenhar preto se necessário ao redimensionar
        if(this.state.fogEnabled) {
             this.fogCtx.fillStyle = '#000000';
             this.fogCtx.fillRect(0,0,4000,4000);
        }
    }

    loop() {
        requestAnimationFrame(() => this.loop());
        this.drawMain();
        this.updatePings();
        this.broadcast();
    }

    // --- RENDERIZAÇÃO MESTRE ---
    drawMain() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        
        ctx.translate(this.state.bgPos.x, this.state.bgPos.y);
        ctx.scale(this.state.bgScale, this.state.bgScale);

        // 1. Mapa
        if (this.local.mapImg) {
            ctx.drawImage(this.local.mapImg, 0, 0);
        } else {
            ctx.fillStyle = "#0b0c10"; ctx.fillRect(-5000, -5000, 10000, 10000);
        }

        // 2. Grid
        if (this.state.fx.grid) this.drawGrid(ctx);

        // 3. Desenhos
        this.state.drawings.forEach(d => {
            ctx.beginPath(); ctx.strokeStyle = d.color; ctx.lineWidth = d.size; 
            ctx.lineCap = 'round'; ctx.moveTo(d.points[0].x, d.points[0].y);
            d.points.forEach(p => ctx.lineTo(p.x, p.y)); ctx.stroke();
        });
        
        // Preview Ferramentas (Pincel)
        if(this.local.tool === 'draw' && this.local.brush.path.length) {
            ctx.beginPath(); ctx.strokeStyle = document.getElementById('brush-color').value; 
            ctx.lineWidth = document.getElementById('brush-size').value; ctx.lineCap='round';
            ctx.moveTo(this.local.brush.path[0].x, this.local.brush.path[0].y);
            this.local.brush.path.forEach(p => ctx.lineTo(p.x, p.y)); ctx.stroke();
        }

        // Preview Seleção de Névoa
        if((this.local.tool === 'fog-reveal' || this.local.tool === 'fog-hide') && this.local.drag.active) {
            const m = this.getMouseWorld(this.local.drag.currentX, this.local.drag.currentY);
            const s = this.getMouseWorld(this.local.drag.start.x, this.local.drag.start.y);
            ctx.fillStyle = this.local.tool === 'fog-reveal' ? "rgba(100,255,100,0.3)" : "rgba(255,100,100,0.3)";
            ctx.fillRect(s.x, s.y, m.x - s.x, m.y - s.y);
            ctx.strokeStyle = "#fff"; ctx.strokeRect(s.x, s.y, m.x - s.x, m.y - s.y);
        }

        // 4. Tokens
        this.state.tokens.forEach(t => {
            const s = t.size * this.state.gridSize;
            if(t.id === this.local.selectedTokenId) {
                ctx.strokeStyle = "#66fcf1"; ctx.lineWidth = 3; 
                ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2 + 5, 0, 6.28); ctx.stroke();
            }
            ctx.save();
            ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2, 0, 6.28); ctx.clip();
            if(t.imgElement) ctx.drawImage(t.imgElement, t.x, t.y, s, s);
            else {
                ctx.fillStyle = "#f00"; ctx.fillRect(t.x, t.y, s, s);
                ctx.fillStyle = "#fff"; ctx.font="bold 20px Arial"; ctx.textAlign="center"; ctx.fillText(t.name[0], t.x+s/2, t.y+s/2+8);
            }
            ctx.restore();
            ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2, 0, 6.28); ctx.strokeStyle="#fff"; ctx.lineWidth=2; ctx.stroke();
        });

        // 5. Máscara (Fog of War) - VISUALIZAÇÃO DO MESTRE
        if(this.local.showMaskOnDM) {
            ctx.save();
            // Mestre vê uma representação da opacidade, mas nunca 100% preto para não perder o mapa.
            // Fórmula: Mínimo 0.1 (pra ver onde tem fog), Máximo 0.6 (pra ver através).
            // Multiplicado pelo slider para dar feedback visual.
            let dmOpacity = 0.1 + (this.state.fogOpacity * 0.5);
            ctx.globalAlpha = dmOpacity; 
            ctx.drawImage(this.fogCanvas, 0, 0);
            ctx.restore();
        }

        // 6. Régua e Pings
        if(this.local.ruler.active && this.local.ruler.start && this.local.ruler.end) {
            const s = this.local.ruler.start; const e = this.local.ruler.end;
            ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
            ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 3; ctx.setLineDash([10, 5]); ctx.stroke(); ctx.setLineDash([]);
            const distPx = Math.sqrt(Math.pow(e.x - s.x, 2) + Math.pow(e.y - s.y, 2));
            const distM = (distPx / this.state.gridSize) * 1.5;
            ctx.fillStyle = "#000"; ctx.fillRect(e.x+10, e.y-25, 60, 20);
            ctx.fillStyle = "#fbbf24"; ctx.font = "bold 14px Arial"; ctx.fillText(distM.toFixed(1) + "m", e.x+15, e.y-10);
        }
        this.local.pings.forEach(p => {
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28);
            ctx.strokeStyle = `rgba(102, 252, 241, ${p.a})`; ctx.lineWidth = 3; ctx.stroke();
        });

        ctx.restore();
    }

    drawGrid(ctx) {
        ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.lineWidth = 1; ctx.beginPath();
        for(let i=0; i<4000; i+=this.state.gridSize) {
            ctx.moveTo(i,0); ctx.lineTo(i,4000); ctx.moveTo(0,i); ctx.lineTo(4000,i);
        }
        ctx.stroke();
    }

    // --- FOG OF WAR (LÓGICA) ---
    updateFogOpacity() {
        const val = document.getElementById('fog-opacity').value;
        this.state.fogOpacity = parseFloat(val);
        document.getElementById('fog-op-val').innerText = Math.round(val * 100) + "%";
        // Forçar broadcast imediato para ver na tela do jogador
        this.broadcast(); 
    }

    resetFog(coverAll) {
        this.fogCtx.globalCompositeOperation = 'source-over';
        this.fogCtx.fillStyle = '#000000';
        if(coverAll) this.fogCtx.fillRect(0, 0, 4000, 4000);
        else this.fogCtx.clearRect(0, 0, 4000, 4000);
        this.broadcastFog();
    }

    applyFogBrush(x, y, w, h, isReveal) {
        this.fogCtx.globalCompositeOperation = isReveal ? 'destination-out' : 'source-over';
        this.fogCtx.fillStyle = '#000000';
        this.fogCtx.fillRect(x, y, w, h);
        this.broadcastFog();
    }

    broadcastFog() {
        const data = this.fogCanvas.toDataURL();
        this.channel.postMessage({ type: 'fogUpdate', data: data });
    }

    toggleMaskVis() { this.local.showMaskOnDM = document.getElementById('mask-toggle').checked; }

    // --- TELA DO JOGADOR (POP-UP) ---
    openPlayerScreen() {
        const win = window.open("", "SITA_PLAYER", "width=800,height=600");
        if(!win) return alert("Pop-up bloqueado! Permita pop-ups para este site.");
        
        win.document.write(`
            <html><head><title>SITA - Jogador</title>
            <style>body{margin:0;background:#000;overflow:hidden;} canvas{width:100vw;height:100vh;display:block;} .fx{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:20;}</style>
            </head><body><div id="fx" class="fx"></div><canvas id="c"></canvas>
            <script>
                const c=document.getElementById('c'); const ctx=c.getContext('2d');
                const ch=new BroadcastChannel('sita_channel');
                let st=null; let fogImg=null; let mapImg=null;
                const imgs={}; let myPan={x:0,y:0}; let myScale=1; let pings=[];
                
                function resize(){c.width=window.innerWidth;c.height=window.innerHeight;}
                window.onresize=resize; resize();

                ch.onmessage=e=>{
                    if(e.data.type==='sync'){
                        st=e.data.state;
                        // Sincronizar pan/zoom se ativado ou se for primeira carga
                        if(st.syncView || (myScale===1 && myPan.x===0)){
                            myPan={...st.bgPos}; myScale=st.bgScale;
                        }
                    }
                    if(e.data.type==='fogUpdate'){ fogImg=new Image(); fogImg.src=e.data.data; }
                    if(e.data.type==='ping'){ pings.push({x:e.data.x, y:e.data.y, r:10, a:1}); }
                };

                function draw() {
                    requestAnimationFrame(draw);
                    if(!st) return;
                    ctx.clearRect(0,0,c.width,c.height);
                    ctx.save();
                    
                    // Aplicar Câmera
                    if(st.syncView) { ctx.translate(st.bgPos.x, st.bgPos.y); ctx.scale(st.bgScale, st.bgScale); }
                    else { ctx.translate(myPan.x, myPan.y); ctx.scale(myScale, myScale); }

                    // 1. MAPA
                    if(st.mapSrc) {
                        if(!mapImg){mapImg=new Image(); mapImg.src=st.mapSrc;}
                        if(mapImg.complete) ctx.drawImage(mapImg,0,0);
                    }
                    // 2. GRID
                    if(st.fx.grid){
                        ctx.strokeStyle="rgba(255,255,255,0.1)"; ctx.beginPath();
                        for(let i=0;i<4000;i+=st.gridSize){ctx.moveTo(i,0);ctx.lineTo(i,4000);ctx.moveTo(0,i);ctx.lineTo(4000,i);}
                        ctx.stroke();
                    }
                    // 3. DESENHOS
                    st.drawings.forEach(d=>{
                        ctx.beginPath(); ctx.strokeStyle=d.color; ctx.lineWidth=d.size; ctx.lineCap='round';
                        ctx.moveTo(d.points[0].x,d.points[0].y); d.points.forEach(p=>ctx.lineTo(p.x,p.y)); ctx.stroke();
                    });
                    // 4. TOKENS
                    st.tokens.forEach(t=>{
                        let s=t.size*st.gridSize;
                        ctx.save(); ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2, 0, 6.28); ctx.clip();
                        if(t.imgSrc){
                            if(!imgs[t.id]){imgs[t.id]=new Image(); imgs[t.id].src=t.imgSrc;}
                            if(imgs[t.id].complete) ctx.drawImage(imgs[t.id],t.x,t.y,s,s);
                        } else { ctx.fillStyle="#f00"; ctx.fillRect(t.x,t.y,s,s); }
                        ctx.restore();
                        ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2, 0, 6.28); ctx.strokeStyle="#fff"; ctx.stroke();
                    });

                    // 5. FOG OF WAR (COM OPACIDADE CORRETA)
                    if(fogImg && st.fogEnabled){
                        ctx.save();
                        // Aplica a opacidade definida pelo slider
                        ctx.globalAlpha = (st.fogOpacity !== undefined) ? st.fogOpacity : 1.0;
                        ctx.drawImage(fogImg, 0, 0);
                        ctx.restore();
                    }
                    
                    // 6. PINGS
                    for(let i=pings.length-1; i>=0; i--){
                        let p = pings[i];
                        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28);
                        ctx.strokeStyle = "rgba(102, 252, 241, "+p.a+")"; ctx.lineWidth=3; ctx.stroke();
                        p.r+=2; p.a-=0.03; if(p.a<=0) pings.splice(i,1);
                    }
                    ctx.restore();
                }
                
                // Navegação Local do Jogador (se sync estiver desligado)
                let dragging=false; let last={x:0,y:0};
                window.onmousedown=e=>{dragging=true; last={x:e.clientX,y:e.clientY}};
                window.onmouseup=()=>dragging=false;
                window.onmousemove=e=>{
                    if(dragging && (!st || !st.syncView)){
                        myPan.x+=e.clientX-last.x; myPan.y+=e.clientY-last.y;
                        last={x:e.clientX,y:e.clientY};
                    }
                };
                window.onwheel=e=>{
                    if(!st||!st.syncView) myScale *= (e.deltaY>0?0.9:1.1);
                };
                
                draw();
            <\/script></body></html>
        `);
    }

    broadcast() {
        const safeState = {
            ...this.state,
            tokens: this.state.tokens.map(t=>({...t, imgElement:null, imgSrc: t.imgElement?t.imgElement.src:null})),
            syncView: this.local.syncView
        };
        this.channel.postMessage({type:'sync', state:safeState});
    }

    // --- FERRAMENTAS BASICAS ---
    toggleSync(){ this.local.syncView = document.getElementById('sync-view-toggle').checked; }
    triggerPing(x,y) { this.local.pings.push({x,y,r:5,a:1}); this.channel.postMessage({type:'ping', x,y}); }
    updatePings() { for(let i=this.local.pings.length-1;i>=0;i--){ let p=this.local.pings[i]; p.r+=2; p.a-=0.03; if(p.a<=0) this.local.pings.splice(i,1); } }
    
    createToken() {
        const name = document.getElementById('token-name').value || 'Token';
        const t = { id:Date.now(), name, x:100, y:100, size:1, imgElement:null };
        if(this.local.tempTokenImg) { const u=URL.createObjectURL(this.local.tempTokenImg); const i=new Image(); i.onload=()=>{t.imgElement=i; t.imgSrc=u;}; i.src=u; this.local.tempTokenImg=null; }
        this.state.tokens.push(t); this.renderTokenList();
    }
    renderTokenList() {
        const l=document.getElementById('token-list'); l.innerHTML="";
        this.state.tokens.forEach(t=>{
            const d=document.createElement('div'); d.className='token-item';
            d.innerHTML=`<span>${t.name}</span>`;
            d.onclick=()=>{this.local.selectedTokenId=t.id; this.local.tool='select'; this.updateTokenUI();};
            l.appendChild(d);
        });
    }
    updateTokenUI(){ const p=document.getElementById('selected-token-controls'); if(this.local.selectedTokenId) p.classList.remove('hidden'); else p.classList.add('hidden'); }
    resizeToken(d){ const t=this.state.tokens.find(x=>x.id===this.local.selectedTokenId); if(t) t.size=Math.max(0.5, t.size+d); }
    deleteSelectedToken(){ this.state.tokens=this.state.tokens.filter(x=>x.id!==this.local.selectedTokenId); this.local.selectedTokenId=null; this.updateTokenUI(); this.renderTokenList(); }
    
    // Initiative
    addInitiative() { const n=document.getElementById('init-name').value; const v=parseInt(document.getElementById('init-val').value)||0; if(!n)return; this.state.initiative.push({name:n,val:v}); this.renderInit(); document.getElementById('init-name').value=""; document.getElementById('init-val').value=""; }
    sortInitiative() { this.state.initiative.sort((a,b)=>b.val-a.val); this.renderInit(); }
    clearInitiative() { this.state.initiative=[]; this.state.activeTurnIndex=0; this.renderInit(); }
    nextTurn() { if(this.state.initiative.length) this.state.activeTurnIndex=(this.state.activeTurnIndex+1)%this.state.initiative.length; this.renderInit(); }
    renderInit(){ 
        const l=document.getElementById('init-list'); l.innerHTML="";
        this.state.initiative.forEach((i,x)=>{
            l.innerHTML+=`<div class="init-item ${x===this.state.activeTurnIndex?'active-turn':''}"><span class="init-val">${i.val}</span><span>${i.name}</span><button class="btn-xs btn-danger" onclick="sita.remInit(${x})">X</button></div>`;
        });
    }
    remInit(x){ this.state.initiative.splice(x,1); this.renderInit(); }

    // Sound
    updateVolume(){ this.local.globalVolume = parseFloat(document.getElementById('global-volume').value); }
    addLocalSound(){
        const f=document.getElementById('sound-file').files[0]; if(!f) return; const u=URL.createObjectURL(f); const n=document.getElementById('sound-label').value||"Som";
        const b=document.createElement('button'); b.className='sound-btn'; b.innerText=n;
        b.onclick=()=>{const a=new Audio(u); a.volume=this.local.globalVolume; a.play();}; b.oncontextmenu=e=>{e.preventDefault();b.remove();};
        document.getElementById('soundboard').appendChild(b);
    }

    toggleFX(k){ this.state.fx[k]=!this.state.fx[k]; document.getElementById('fx-overlay').className='fx-layer '+(this.state.fx.rain?'fx-rain ':'')+(this.state.fx.fog?'fx-fog ':'')+(this.state.fx.vignette?'fx-vignette ':'')+(this.state.fx.fire?'fx-fire ':''); }
    
    // DB & UI
    initDB() { const r=indexedDB.open("SITA_DB",1); r.onupgradeneeded=e=>e.target.result.createObjectStore("files",{keyPath:"name"}); r.onsuccess=e=>{this.db=e.target.result; this.loadFileStore();}; }
    saveFileToDB(f) { if(!this.db)return; const r=new FileReader(); r.onload=()=>{this.db.transaction("files","readwrite").objectStore("files").put({name:f.name,type:f.type,data:r.result}); this.loadFileStore();}; r.readAsDataURL(f); }
    loadFileStore() { 
        this.db.transaction("files","readonly").objectStore("files").getAll().onsuccess=e=>{
            document.getElementById('file-list').innerHTML = e.target.result.map(f=>`<div class="file-item"><span>${f.name}</span><a href="${f.data}" download="${f.name}"><i class="fas fa-download"></i></a></div>`).join('');
        };
    }
    saveNotes(){ localStorage.setItem('sita_notes', document.getElementById('private-notes').value); }
    loadNotes(){ document.getElementById('private-notes').value = localStorage.getItem('sita_notes') || ""; }
    
    setupInputs() {
        document.getElementById('map-upload').onchange = e => { const f=e.target.files[0]; if(f){ const u=URL.createObjectURL(f); const i=new Image(); i.onload=()=>{this.local.mapImg=i; this.state.mapSrc=u; this.state.bgPos={x:0,y:0};}; i.src=u; } };
        document.getElementById('token-img-upload').onchange = e => this.local.tempTokenImg = e.target.files[0];
        document.getElementById('file-storage-upload').onchange = e => this.saveFileToDB(e.target.files[0]);
    }
    setupMouse() {
        this.canvas.onmousedown = e => {
            if(e.shiftKey) { const p=this.getMouseWorld(e); this.triggerPing(p.x,p.y); return; }
            this.local.drag.active=true; this.local.drag.start={x:e.clientX,y:e.clientY}; this.local.drag.currentX=e.clientX; this.local.drag.currentY=e.clientY;
            const w=this.getMouseWorld(e);
            if(this.local.tool==='select') {
                const t=[...this.state.tokens].reverse().find(x=>w.x>=x.x&&w.x<=x.x+(x.size*50)&&w.y>=x.y&&w.y<=x.y+(x.size*50));
                if(t){this.local.selectedTokenId=t.id; this.local.drag.offset={x:w.x-t.x,y:w.y-t.y};} else {this.local.selectedTokenId=null; this.local.tool='pan-temp';}
                this.updateTokenUI();
            } else if(this.local.tool==='draw') this.local.brush.path=[w];
            else if(this.local.tool.includes('fog')) this.local.fogStart=w;
            else if(this.local.tool==='ruler') {this.local.ruler.active=true; this.local.ruler.start=w; this.local.ruler.end=w;}
        };
        this.canvas.onmousemove = e => {
            if(!this.local.drag.active) return;
            const w=this.getMouseWorld(e); this.local.drag.currentX=e.clientX; this.local.drag.currentY=e.clientY;
            if(this.local.tool==='pan'||this.local.tool==='pan-temp') { this.state.bgPos.x+=e.clientX-this.local.drag.start.x; this.state.bgPos.y+=e.clientY-this.local.drag.start.y; this.local.drag.start={x:e.clientX,y:e.clientY}; }
            else if(this.local.tool==='select'&&this.local.selectedTokenId){ const t=this.state.tokens.find(x=>x.id===this.local.selectedTokenId); if(t){t.x=w.x-this.local.drag.offset.x; t.y=w.y-this.local.drag.offset.y;} }
            else if(this.local.tool==='draw') this.local.brush.path.push(w);
            else if(this.local.tool==='ruler') this.local.ruler.end=w;
        };
        this.canvas.onmouseup = e => {
            this.local.drag.active=false; const w=this.getMouseWorld(e);
            if(this.local.tool==='pan-temp') this.local.tool='select';
            if(this.local.tool==='draw') { this.state.drawings.push({points:[...this.local.brush.path],color:document.getElementById('brush-color').value,size:document.getElementById('brush-size').value}); this.local.brush.path=[]; }
            else if(this.local.tool.includes('fog')) { const s=this.local.fogStart; this.applyFogBrush(s.x, s.y, w.x-s.x, w.y-s.y, this.local.tool==='fog-reveal'); }
            else if(this.local.tool==='ruler') this.local.ruler.active=false;
        };
        this.canvas.onwheel = e => { e.preventDefault(); this.state.bgScale *= (e.deltaY>0?0.9:1.1); };
    }
    
    // Helpers
    setTool(t) { this.local.tool=t; document.querySelectorAll('.tool-group button').forEach(b=>b.classList.remove('active')); const m={'pan':'btn-pan','select':'btn-sel','draw':'btn-draw','ruler':'btn-rul','fog-reveal':'btn-reveal','fog-hide':'btn-hide'}; if(m[t]) document.getElementById(m[t]).classList.add('active'); this.canvas.style.cursor=(t==='pan')?'grab':(t==='select')?'default':'crosshair'; }
    getMouseWorld(e) { const r=this.canvas.getBoundingClientRect(); return {x:(e.clientX-r.left-this.state.bgPos.x)/this.state.bgScale, y:(e.clientY-r.top-this.state.bgPos.y)/this.state.bgScale}; }
    openTab(id) { document.querySelectorAll('.tab-content').forEach(e=>e.classList.add('hidden')); document.querySelectorAll('.tab-btn').forEach(e=>e.classList.remove('active')); document.getElementById('tab-'+id).classList.remove('hidden'); }
    
    // Dice
    roll(f){this.processRoll(f);} rollCustom(){this.processRoll(document.getElementById('formula-input').value);}
    processRoll(s){try{ const m=s.match(/(\d+)d(\d+)([+-]\d+)?/); if(!m) throw "E"; let r=[], t=0; for(let i=0;i<parseInt(m[1]);i++) r.push(Math.floor(Math.random()*parseInt(m[2]))+1); t=r.reduce((a,b)=>a+b,0)+(m[3]?parseInt(m[3]):0); const d=document.createElement('div'); d.className='log-entry'; d.innerHTML=`<div>${s}</div><div style="font-size:0.8em;color:#aaa">[${r}]</div><div class="log-result">${t}</div>`; document.getElementById('chat-log').prepend(d); }catch(e){}}
    clearLog(){document.getElementById('chat-log').innerHTML="";}
    clearDrawings(){this.state.drawings=[];}
}

const sita = new SITA();