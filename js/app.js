/**
 * Standalone Sprint Planning Poker - App Entry Point
 */

import { PokerUIController } from './ui.js';
import { initUsageWidget } from './usage.js';

document.addEventListener('DOMContentLoaded', () => {
    console.log('[Sprint Planning Poker] Initializing standalone application...');
    initUsageWidget();
    window.pokerApp = new PokerUIController();
});
