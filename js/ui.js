/**
 * Standalone Sprint Planning Poker - UI Controller & Event Handlers
 */

import { pokerState, DECKS } from './state.js';
import { PokerNetworkController } from './network.js';
import { PokerEngine } from './engine.js';
import { showQRCodeModal } from './qrcode.js';

export class PokerUIController {
    constructor() {
        this.network = new PokerNetworkController();
        this.initDOM();
        this.bindEvents();
        this.checkURLParams();
        this.subscribeState();
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
        this.btnJoinRoom = document.getElementById('btn-join-room');
        this.btnCreateRoom = document.getElementById('btn-create-room');

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
            const name = this.inputPlayerName.value.trim() || 'Scrum Master';
            const code = this._generateRoomCode();
            this.btnCreateRoom.disabled = true;
            this.btnCreateRoom.textContent = 'Creating Session...';
            try {
                await this.network.createRoom(code, name);
                this._showNotification(`Session Created! Code: ${code}`, 'success');
            } catch (err) {
                this._showNotification(err.message || 'Failed to create room.', 'error');
                this.btnCreateRoom.disabled = false;
                this.btnCreateRoom.textContent = 'Create Session as Host →';
            }
        });

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
                this._showNotification(err.message || 'Failed to join session.', 'error');
                this.btnJoinRoom.disabled = false;
                this.btnJoinRoom.textContent = 'Join Session →';
            }
        });

        // Shareable Link Copy
        this.btnShareLink.addEventListener('click', () => {
            const code = pokerState.get().roomCode;
            if (!code) return;
            const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
            navigator.clipboard.writeText(url).then(() => {
                this._showNotification('🔗 Share link copied to clipboard!', 'success');
            }).catch(() => {
                prompt('Copy Room URL:', url);
            });
        });

        // QR Code Generator
        this.btnQRCode.addEventListener('click', () => {
            const code = pokerState.get().roomCode || this.inputRoomCode.value.trim().toUpperCase();
            if (!code) {
                this._showNotification('Please enter or create a Room Code first!', 'warning');
                return;
            }
            const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
            showQRCodeModal(url, code);
        });

        // Exit Room
        this.btnExitRoom.addEventListener('click', () => {
            if (confirm('Are you sure you want to exit the room?')) {
                this.network.disconnect();
                pokerState.reset();
                window.location.search = '';
            }
        });

        // Edit Story
        this.btnEditStory.addEventListener('click', () => {
            const st = pokerState.get();
            const newTitle = prompt('Enter User Story Title / ID:', st.currentStory.title);
            if (newTitle !== null && newTitle.trim()) {
                const newDesc = prompt('Enter Brief Description (Optional):', st.currentStory.description) || '';
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

    checkURLParams() {
        const params = new URLSearchParams(window.location.search);
        const roomParam = params.get('room') || params.get('code');
        if (roomParam) {
            this.inputRoomCode.value = roomParam.toUpperCase();
            this.tabJoin.click();
            this._showNotification(`Room code ${roomParam.toUpperCase()} loaded from link!`, 'info');
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
        this.renderVotingDeck(st);

        if (st.roundStatus === 'REVEALED') {
            this.badgeRoundStatus.textContent = '👁️ VOTES REVEALED';
            this.badgeRoundStatus.className = 'voting-status-badge badge-revealed';
        } else {
            this.badgeRoundStatus.textContent = '⏳ VOTING IN PROGRESS';
            this.badgeRoundStatus.className = 'voting-status-badge badge-voting';
        }

        this.renderPlayersGrid(st);
        this.renderStats(st);

        const isHost = (st.role === 'HOST');
        this.btnReveal.style.display = isHost ? 'inline-block' : 'none';
        this.btnReset.style.display = isHost ? 'inline-block' : 'none';
        this.btnSaveStory.style.display = isHost ? 'inline-block' : 'none';

        this.renderHistory(st.history);
    }

    renderVotingDeck(st) {
        const deckDef = DECKS[st.deckType] || DECKS.fibonacci;
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

            btn.addEventListener('click', () => {
                const newVote = (st.myVote === val) ? null : val;
                this.network.submitVote(newVote);
            });

            this.deckCardsContainer.appendChild(btn);
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
            seatEl.className = 'player-seat';

            let cardContentHtml = '';
            if (isRevealed) {
                const displayVal = voteVal || '—';
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
                    ${p.displayName}
                    ${p.id === st.myPeerId ? '<span class="player-role-tag">YOU</span>' : ''}
                </div>
            `;

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

        const consensusHtml = stats.isConsensus
            ? `<span style="color:#34d399; font-weight:700;">🎉 Unanimous (${stats.consensusValue} pts)</span>`
            : `<span style="color:#f59e0b; font-weight:700;">⚠️ Range (${stats.min} – ${stats.max})</span>`;

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
                <div class="dist-bar-val">${val}</div>
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
                <div class="history-item-title">${item.title}</div>
                <div class="history-item-points">${item.agreedPoints} Points</div>
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
        const div = document.createElement('div');
        div.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            padding: 12px 20px;
            background: #1e293b;
            color: #ffffff;
            border-radius: 8px;
            border-left: 4px solid ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#6366f1'};
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            z-index: 1000;
            font-size: 0.9rem;
            font-weight: 600;
        `;
        div.textContent = msg;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 3000);
    }
}
