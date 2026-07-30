/**
 * Standalone Sprint Planning Poker - App Entry Point
 */

import { PokerUIController } from './ui.js';

document.addEventListener('DOMContentLoaded', () => {
    console.log('[Sprint Planning Poker] Initializing standalone application...');
    window.pokerApp = new PokerUIController();
});
