/**
 * Standalone Sprint Planning Poker - App Entry Point
 */

import { PokerUIController } from './ui.js?v=2.3.1';
import { initUsageWidget } from './usage.js?v=2.3.1';

document.addEventListener('DOMContentLoaded', () => {
    console.log('[Sprint Planning Poker] Initializing standalone application...');
    initUsageWidget();
    window.pokerApp = new PokerUIController();
});
