/**
 * Standalone Sprint Planning Poker - UI Controller & Event Handlers
 */

import { pokerState, DECKS, getResumeTarget, getSeat, clearSession, clearLastRoom } from './state.js?v=2.3.0';
import { PokerNetworkController } from './network.js?v=2.3.0';
import { PokerEngine } from './engine.js?v=2.3.0';
import { showQRCodeModal } from './qrcode.js?v=2.3.0';
import { escapeHtml, isValidRoomCode } from './util.js?v=2.3.0';

export class PokerUIController {
    constructor() {
        this.network = new PokerNetworkController();
        this.network.onError = (msg) => this._showNotification(msg, 'error');
        this.network.onNotice = (msg) => this._showNotification(msg, 'info');
        this.initDOM();
        this.bindEvents();
        this.checkURLParams();
        this.subscribeState();
        this.restoreSession();
    }

    initDOM() {
        this.headerRoomCode = document.getElementById('header-room-code');
        this.headerRoleBadge = document.getElementById('header-role-badge');

        this.btnShareLink = document.getElementById('btn-share-link');
        this.btnQRCode = document.getElementById('btn-qr-code');
        this.btnExitRoom = document.getElementById('btn-exit-room');

        this.viewLobby = document.getElementById('view-lobby');
        this.viewRoom = document.getElementById('view-room');

        this.tabJoin = document.getElementById('tab-join');
        this.tabCreate = document.getElementById('tab-create');
        this.sectionJoin = document.getElementById('section-join');
        this.sectionCreate = document.getElementById('section-create');

        this.inputRoomCode = document.getElementById('input-room-code');
        this.inputPlayerName = document.getElementById('input-player-name');
        this.inputHostName = document.getElementById('input-host-name');
        this.btnJoinRoom = document.getElementById('btn-join-room');
        this.btnCreateRoom = document.getElementById('btn-create-room');
        this.btnShowSeats = document.getElementById('btn-show-seats');
        this.seatPicker = document.getElementById('seat-picker');

        this.storyTitle = document.getElementById('story-title');
        this.storyDesc = document.getElementById('story-desc');
        this.btnEditStory = document.getElementById('btn-edit-story');

        this.selectDeck = document.getElementById('select-deck');
        this.deckCardsContainer = document.getElementById('deck-cards-list');

        this.badgeRoundStatus = document.getElementById('badge-round-status');
        this.playersGrid = document.getElementById('players-grid');

        this.btnReveal = document.getElementById('btn-reveal');
        this.btnReset = document.getElementById('btn-reset');
        this.btnSaveStory = document.getElementById('btn-save-story');

        this.statsContainer = document.getElementById('stats-container');
        this.historyList = document.getElementById('history-list');
        this.btnExportCSV = document.getElementById('btn-export-csv');
    }

    bindEvents() {
        // Tab switching
        this.tabJoin.addEventListener('click', () => {
            this.tabJoin.classList.add('active');
            this.tabCreate.classList.remove('active');
            this.sectionJoin.style.display = 'block';
            this.sectionCreate.style.display = 'none';
        });

        this.tabCreate.addEventListener('click', () => {
            this.tabCreate.classList.add('active');
            this.tabJoin.classList.remove('active');
            this.sectionCreate.style.display = 'block';
            this.sectionJoin.style.display = 'none';
        });

        // Host Create Room
        this.btnCreateRoom.addEventListener('click', async () => {
            const name = this.inputHostName.value.trim() || this.inputPlayerName.value.trim() || 'Scrum Master';
            this.btnCreateRoom.disabled = true;
            this.btnCreateRoom.textContent = 'Creating Session...';
            try {
                let code;
                // A freshly generated code can (rarely) collide with a live room: retry.
                for (let attempt = 0; ; attempt++) {
                    code = this._generateRoomCode();
                    try {
                        await this.network.createRoom(code, name);
                        break;
                    } catch (err) {
                        if (err.status !== 409 || attempt >= 4) throw err;
                    }
                }
                this._showNotification(`Session Created! Code: ${code}`, 'success');
            } catch (err) {
                if (err.status === -1) return; // superseded by a newer action
                this._showNotification(err.message || 'Failed to create room.', 'error');
                this.btnCreateRoom.disabled = false;
                this.btnCreateRoom.textContent = 'Create Session as Host →';
            }
        });

        // Rejoin a previous seat (lost token, closed tab, cleared storage)
        this.btnShowSeats.addEventListener('click', () => this.toggleSeatPicker());

        // Player Join Room
        this.btnJoinRoom.addEventListener('click', async () => {
            const code = this.inputRoomCode.value.trim().toUpperCase();
            const name = this.inputPlayerName.value.trim();

            if (!code || code.length < 4) {
                this._showNotification('Please enter a valid Room Code.', 'warning');
                return;
            }
            if (!name) {
                this._showNotification('Please enter your Display Name.', 'warning');
                return;
            }

            this.btnJoinRoom.disabled = true;
            this.btnJoinRoom.textContent = 'Connecting...';
            try {
                await this.network.joinRoom(code, name);
                this._showNotification('Joined Session Successfully!', 'success');
            } catch (err) {
                if (err.status === -1) return; // superseded by a newer action
                if (err.code === 'name_inactive' && err.data && err.data.seatRef) {
                    this.offerJoinBack(code, err.data);
                } else {
                    this._showNotification(err.message || 'Failed to join session.', 'error');
                }
                this.btnJoinRoom.disabled = false;
                this.btnJoinRoom.textContent = 'Join Session →';
            }
        });

        // Shareable Link Copy
        this.btnShareLink.addEventListener('click', () => {
            const st = pokerState.get();
            const code = st.role !== 'LOBBY' ? st.roomCode : null;
            if (!isValidRoomCode(code)) return;
            const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
            const copy = navigator.clipboard && navigator.clipboard.writeText
                ? navigator.clipboard.writeText(url)
                : Promise.reject(new Error('Clipboard unavailable'));
            copy.then(() => {
                this._showNotification('🔗 Share link copied to clipboard!', 'success');
            }).catch(() => {
                prompt('Copy Room URL:', url);
            });
        });

        // QR Code Generator
        this.btnQRCode.addEventListener('click', () => {
            const st = pokerState.get();
            const code = st.role !== 'LOBBY' ? st.roomCode : this.inputRoomCode.value.trim().toUpperCase();
            if (!isValidRoomCode(code)) {
                this._showNotification('Please enter or create a Room Code first!', 'warning');
                return;
            }
            const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
            showQRCodeModal(url, code);
        });

        // Exit Room
        this.btnExitRoom.addEventListener('click', async () => {
            if (confirm('Are you sure you want to exit the room?')) {
                await this.network.exit(); // frees the seat on the server before the page reloads
                pokerState.reset();
                window.location.search = '';
            }
        });

        // Edit Story
        this.btnEditStory.addEventListener('click', () => {
            const st = pokerState.get();
            const newTitle = prompt('Enter User Story Title / ID:', st.currentStory.title);
            if (newTitle !== null && newTitle.trim()) {
                const newDesc = prompt('Enter Brief Description (Optional):', st.currentStory.description);
                if (newDesc === null) return; // Cancel keeps the current story untouched
                this.network.updateStory(newTitle, newDesc);
            }
        });

        // Change Deck
        this.selectDeck.addEventListener('change', (e) => {
            this.network.changeDeck(e.target.value);
        });

        // Facilitator Buttons
        this.btnReveal.addEventListener('click', () => {
            this.network.revealVotes();
        });

        this.btnReset.addEventListener('click', () => {
            this.network.resetVotes();
        });

        this.btnSaveStory.addEventListener('click', () => {
            const st = pokerState.get();
            const stats = PokerEngine.calculateStats(st.votes);
            const defaultPoints = stats.consensusValue || (stats.numericVotesCount > 0 ? stats.median : '3');

            const agreed = prompt('Confirm Final Agreed Story Points:', defaultPoints);
            if (agreed !== null && agreed.trim()) {
                this.network.saveStoryEstimate(agreed.trim());
            }
        });

        // Export CSV
        this.btnExportCSV.addEventListener('click', () => {
            const history = pokerState.get().history;
            if (history.length === 0) {
                this._showNotification('No estimated stories recorded yet.', 'warning');
                return;
            }
            PokerEngine.exportToCSV(history);
        });
    }

    /** Show/hide the list of inactive seats for the typed room code. */
    async toggleSeatPicker() {
        if (this.seatPicker.style.display !== 'none') {
            this.seatPicker.style.display = 'none';
            return;
        }
        const code = this.inputRoomCode.value.trim().toUpperCase();
        if (!isValidRoomCode(code)) {
            this._showNotification('Enter the Room Code first.', 'warning');
            return;
        }
        await this.refreshSeatPicker(code);
    }

    async refreshSeatPicker(code) {
        this.seatPicker.style.display = 'flex';
        this.seatPicker.replaceChildren();
        const hint = (text) => {
            const p = document.createElement('div');
            p.className = 'seat-hint';
            p.textContent = text;
            this.seatPicker.appendChild(p);
        };

        let seats;
        try {
            seats = await this.network.listSeats(code);
        } catch (err) {
            hint(err.message || 'Could not load seats.');
            return;
        }

        if (seats.length === 0) {
            hint('No inactive seats in this room. Use "Join Session" to join as a new player.');
            return;
        }

        hint('Pick your name to continue as that player:');
        seats.forEach((seat) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'seat-option';

            const name = document.createElement('span');
            name.textContent = seat.displayName;
            const meta = document.createElement('span');
            meta.className = 'seat-meta';
            const mins = Math.floor(seat.inactiveSeconds / 60);
            meta.textContent = mins >= 1 ? `inactive ${mins} min` : 'inactive < 1 min';
            btn.append(name, meta);

            btn.addEventListener('click', () => this.claimSeat(code, seat.ref, btn, seat.displayName));
            this.seatPicker.appendChild(btn);
        });

        const first = this.seatPicker.querySelector('.seat-option');
        if (first) first.focus();
    }

    /** "<Name> is inactive. Join back as <Name>?" shown when the typed name matches an inactive seat. */
    offerJoinBack(code, data) {
        this.seatPicker.style.display = 'flex';
        this.seatPicker.replaceChildren();

        const hint = document.createElement('div');
        hint.className = 'seat-hint';
        hint.textContent = `${data.seatName} is inactive. Is that you?`;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seat-option';
        const label = document.createElement('span');
        label.textContent = `Join back as ${data.seatName}`;
        btn.appendChild(label);
        btn.addEventListener('click', () => this.claimSeat(code, data.seatRef, btn, data.seatName));

        const alt = document.createElement('div');
        alt.className = 'seat-hint';
        alt.textContent = 'Not you? Type a different name above and join again.';

        this.seatPicker.append(hint, btn, alt);
        btn.focus();
    }

    async claimSeat(code, ref, btn, name) {
        btn.disabled = true;
        try {
            try {
                await this.network.claimSeat(code, ref);
            } catch (err) {
                if (err.code !== 'own_seat') throw err;
                // This browser already holds a seat in the room: resume that one, under its own name.
                const own = getSeat(code);
                if (!own) throw err;
                await this.network.joinRoom(code, own.displayName || pokerState.get().displayName || '');
            }
            this._showNotification('Seat restored. Welcome back!', 'success');
        } catch (err) {
            if (err.status === -1) return; // superseded by a newer action
            this._showNotification(err.message || 'Could not take over that seat.', 'error');
            // The list is stale (seat taken/active/removed): reload it
            if (err.status === 404 || err.status === 409) await this.refreshSeatPicker(code);
            else btn.disabled = false;
        }
    }

    checkURLParams() {
        const params = new URLSearchParams(window.location.search);
        const roomParam = (params.get('room') || params.get('code') || '').trim().toUpperCase();
        if (isValidRoomCode(roomParam)) {
            this.inputRoomCode.value = roomParam;
            this.tabJoin.click();
            this._showNotification(`Room code ${roomParam} loaded from link!`, 'info');
        }

        // Prefill the remembered display name on both entry forms
        const savedName = pokerState.get().displayName;
        if (savedName) {
            this.inputPlayerName.value = savedName;
            this.inputHostName.value = savedName;
        }
    }

    /** After a reload, silently rejoin the room this tab was in (keeps host seat + token). */
    async restoreSession() {
        const sess = getResumeTarget();
        if (!sess || !isValidRoomCode(sess.roomCode)) return;

        // A different room in the link means the user wants to switch rooms.
        const linked = this.inputRoomCode.value.trim().toUpperCase();
        if (linked && linked !== sess.roomCode) return;

        try {
            await this.network.joinRoom(sess.roomCode, sess.displayName || 'Guest');
        } catch (err) {
            if (err.status === -1) return; // superseded by the user's own action
            // Room expired or seat is gone: stay in the lobby with the code prefilled.
            this.inputRoomCode.value = sess.roomCode;
            if (err.code === 'name_inactive' && err.data && err.data.seatRef) {
                this.inputPlayerName.value = sess.displayName || '';
                this.tabJoin.click();
                this.offerJoinBack(sess.roomCode, err.data);
                return;
            }
            if (err.status === 404 || err.status === 403) {
                clearSession(); // keep everything on transient errors
                clearLastRoom(sess.roomCode);
            }
            this._showNotification(`Could not rejoin your previous session: ${err.message}`, 'warning');
        }
    }

    subscribeState() {
        pokerState.subscribe((st) => this.render(st));
    }

    render(st) {
        if (st.role === 'LOBBY') {
            this.viewLobby.classList.add('active');
            this.viewRoom.classList.remove('active');
            this.headerRoomCode.textContent = '------';
            this.headerRoleBadge.style.display = 'none';
            this.btnExitRoom.style.display = 'none';
            this.btnJoinRoom.disabled = false;
            this.btnJoinRoom.textContent = 'Join Session →';
            this.btnCreateRoom.disabled = false;
            this.btnCreateRoom.textContent = 'Create Session as Host →';
            this._deckKey = this._gridKey = this._statsKey = this._historyKey = null;
            this.seatPicker.style.display = 'none';
            return;
        }

        this.viewLobby.classList.remove('active');
        this.viewRoom.classList.add('active');

        this.headerRoomCode.textContent = st.roomCode;
        this.headerRoleBadge.style.display = 'inline-block';
        this.headerRoleBadge.textContent = st.role;
        this.btnExitRoom.style.display = 'inline-block';

        this.storyTitle.textContent = st.currentStory.title;
        this.storyDesc.textContent = st.currentStory.description || 'No description provided';
        this.btnEditStory.style.display = (st.role === 'HOST') ? 'inline-block' : 'none';

        this.selectDeck.value = st.deckType;
        this.selectDeck.disabled = (st.role !== 'HOST');
        const deckKey = [st.deckType, st.myVote, st.roundStatus, st.isObserver].join('|');
        if (deckKey !== this._deckKey) {
            this._deckKey = deckKey;
            this.renderVotingDeck(st);
        }

        if (st.roundStatus === 'REVEALED') {
            this.badgeRoundStatus.textContent = '👁️ VOTES REVEALED';
            this.badgeRoundStatus.className = 'voting-status-badge badge-revealed';
        } else {
            this.badgeRoundStatus.textContent = '⏳ VOTING IN PROGRESS';
            this.badgeRoundStatus.className = 'voting-status-badge badge-voting';
        }

        // Only rebuild the parts whose inputs changed (keeps keyboard focus on the deck).
        const gridKey = JSON.stringify([st.players, st.votes, st.roundStatus, st.myPeerId, st.role]);
        if (gridKey !== this._gridKey) {
            this._gridKey = gridKey;
            this.renderPlayersGrid(st);
        }
        const statsKey = JSON.stringify([st.votes, st.roundStatus]);
        if (statsKey !== this._statsKey) {
            this._statsKey = statsKey;
            this.renderStats(st);
        }

        const isHost = (st.role === 'HOST');
        this.btnReveal.style.display = isHost ? 'inline-block' : 'none';
        this.btnReset.style.display = isHost ? 'inline-block' : 'none';
        // Saving only makes sense once the votes are revealed
        this.btnSaveStory.style.display = (isHost && st.roundStatus === 'REVEALED') ? 'inline-block' : 'none';

        const historyKey = JSON.stringify(st.history);
        if (historyKey !== this._historyKey) {
            this._historyKey = historyKey;
            this.renderHistory(st.history);
        }
    }

    renderVotingDeck(st) {
        const deckDef = DECKS[st.deckType] || DECKS.fibonacci;
        const active = document.activeElement;
        const focusedValue = active && this.deckCardsContainer.contains(active) ? active.textContent : null;
        this.deckCardsContainer.innerHTML = '';

        if (st.isObserver) {
            this.deckCardsContainer.innerHTML = '<span style="color:var(--text-muted); font-size:0.9rem;">Observer Mode (viewing only).</span>';
            return;
        }

        deckDef.cards.forEach((val) => {
            const btn = document.createElement('button');
            btn.className = 'deck-card';
            if (st.myVote === val) btn.classList.add('selected');
            btn.textContent = val;
            btn.disabled = (st.roundStatus === 'REVEALED'); // votes are locked after reveal

            btn.addEventListener('click', () => {
                const newVote = (st.myVote === val) ? null : val;
                this.network.submitVote(newVote);
            });

            this.deckCardsContainer.appendChild(btn);
            if (focusedValue !== null && val === focusedValue) btn.focus();
        });
    }

    renderPlayersGrid(st) {
        this.playersGrid.innerHTML = '';

        if (!st.players || st.players.length === 0) {
            this.playersGrid.innerHTML = '<p style="color:var(--text-muted);">Waiting for team members to join...</p>';
            return;
        }

        st.players.forEach((p) => {
            const hasVoted = Boolean(st.votes[p.id]);
            const voteVal = st.votes[p.id];
            const isRevealed = (st.roundStatus === 'REVEALED');

            const seatEl = document.createElement('div');
            seatEl.className = 'player-seat' + (p.connected === false ? ' disconnected' : '');

            let cardContentHtml = '';
            if (isRevealed) {
                const displayVal = escapeHtml(voteVal || '—');
                cardContentHtml = `
                    <div class="poker-card-3d flipped">
                        <div class="poker-card-inner">
                            <div class="poker-card-back ${hasVoted ? 'voted' : ''}">🃏</div>
                            <div class="poker-card-front">${displayVal}</div>
                        </div>
                    </div>
                `;
            } else {
                cardContentHtml = `
                    <div class="poker-card-3d">
                        <div class="poker-card-inner">
                            <div class="poker-card-back ${hasVoted ? 'voted' : ''}">
                                ${hasVoted ? '👍' : '🃏'}
                            </div>
                            <div class="poker-card-front">?</div>
                        </div>
                    </div>
                `;
            }

            seatEl.innerHTML = `
                ${cardContentHtml}
                <div class="player-name">
                    ${escapeHtml(p.displayName)}
                    ${p.id === st.myPeerId ? '<span class="player-role-tag">YOU</span>' : ''}
                </div>
            `;

            // The host can hand the role to any other connected player
            if (st.role === 'HOST' && p.id !== st.myPeerId && p.connected !== false) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'make-host-btn';
                btn.textContent = 'Make host';
                btn.title = `Make ${p.displayName} the host`;
                btn.addEventListener('click', () => {
                    const acting = pokerState.get().actingHost;
                    const warning = acting
                        ? 'You are the acting host: the original host will NOT get the host role back.'
                        : 'You will lose the host controls.';
                    if (confirm(`Make ${p.displayName} the host? ${warning}`)) {
                        this.network.makeHost(p.id);
                    }
                });
                seatEl.appendChild(btn);
            }

            this.playersGrid.appendChild(seatEl);
        });
    }

    renderStats(st) {
        if (st.roundStatus !== 'REVEALED') {
            this.statsContainer.style.display = 'none';
            return;
        }

        this.statsContainer.style.display = 'block';
        const stats = PokerEngine.calculateStats(st.votes);

        let consensusHtml;
        if (stats.isConsensus) {
            consensusHtml = `<span style="color:#34d399; font-weight:700;">🎉 Unanimous (${escapeHtml(stats.consensusValue)} pts)</span>`;
        } else if (stats.numericVotesCount === 0) {
            consensusHtml = '<span style="color:#94a3b8; font-weight:700;">No numeric votes</span>';
        } else if (stats.min === stats.max) {
            consensusHtml = `<span style="color:#94a3b8; font-weight:700;">Single value (${stats.min} pts)</span>`;
        } else {
            consensusHtml = `<span style="color:#f59e0b; font-weight:700;">⚠️ Range (${stats.min} – ${stats.max})</span>`;
        }

        document.getElementById('stat-average').textContent = stats.numericVotesCount > 0 ? stats.average : '—';
        document.getElementById('stat-median').textContent = stats.numericVotesCount > 0 ? stats.median : '—';
        document.getElementById('stat-consensus').innerHTML = consensusHtml;

        const distContainer = document.getElementById('dist-chart-container');
        distContainer.innerHTML = '';

        if (Object.keys(stats.distribution).length === 0) {
            distContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No votes cast.</p>';
            return;
        }

        Object.entries(stats.distribution).forEach(([val, count]) => {
            const pct = Math.round((count / stats.totalVotes) * 100);
            const row = document.createElement('div');
            row.className = 'dist-bar-item';
            row.innerHTML = `
                <div class="dist-bar-val">${escapeHtml(val)}</div>
                <div class="dist-bar-track">
                    <div class="dist-bar-fill" style="width: ${pct}%;"></div>
                </div>
                <div class="dist-bar-count">${count} vote${count > 1 ? 's' : ''} (${pct}%)</div>
            `;
            distContainer.appendChild(row);
        });
    }

    renderHistory(history) {
        this.historyList.innerHTML = '';
        if (!history || history.length === 0) {
            this.historyList.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No estimates recorded in this session yet.</p>';
            return;
        }

        history.forEach((item) => {
            const el = document.createElement('div');
            el.className = 'history-item';
            el.innerHTML = `
                <div class="history-item-title">${escapeHtml(item.title)}</div>
                <div class="history-item-points">${escapeHtml(item.agreedPoints)} Points</div>
            `;
            this.historyList.appendChild(el);
        });
    }

    _generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    _showNotification(msg, type = 'info') {
        // Stack toasts in one live region so they never overlap and are announced to screen readers.
        let stack = document.getElementById('toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'toast-stack';
            stack.setAttribute('role', 'status');
            stack.setAttribute('aria-live', 'polite');
            stack.style.cssText = 'position:fixed; bottom:24px; right:24px; display:flex; flex-direction:column; gap:8px; z-index:1000; max-width:calc(100vw - 48px);';
            document.body.appendChild(stack);
        }
        const div = document.createElement('div');
        div.style.cssText = `
            padding: 12px 20px;
            background: #1e293b;
            color: #ffffff;
            border-radius: 8px;
            border-left: 4px solid ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#6366f1'};
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            font-size: 0.9rem;
            font-weight: 600;
        `;
        div.textContent = msg;
        stack.appendChild(div);
        setTimeout(() => div.remove(), 4000);
    }
}
