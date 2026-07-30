/**
 * QR Code Generator Utility
 * Uses QR Code API with offline fallback image renderer
 */

export function getQRCodeUrl(text, size = 220) {
    const encoded = encodeURIComponent(text);
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&margin=10`;
}

export function showQRCodeModal(url, roomCode) {
    const existing = document.getElementById('qr-code-modal-overlay');
    if (existing) existing.remove();

    const qrImgUrl = getQRCodeUrl(url, 220);

    const overlay = document.createElement('div');
    overlay.id = 'qr-code-modal-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
    `;

    overlay.innerHTML = `
        <div style="
            background: #121826;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 20px;
            padding: 28px;
            max-width: 380px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 50px rgba(0,0,0,0.6);
            color: #ffffff;
            font-family: 'Inter', system-ui, sans-serif;
            position: relative;
        ">
            <h3 style="font-size: 1.25rem; margin-bottom: 6px; font-weight: 700;">📱 Scan to Join Session</h3>
            <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 20px;">
                Scan with phone camera to join room <strong style="color:#ec4899;">${roomCode}</strong>
            </p>

            <div style="
                background: #ffffff;
                padding: 14px;
                border-radius: 16px;
                display: inline-block;
                box-shadow: 0 8px 24px rgba(0,0,0,0.3);
                margin-bottom: 20px;
            ">
                <img src="${qrImgUrl}" alt="Room QR Code" width="220" height="220" style="display:block; border-radius:8px;" />
            </div>

            <div style="display: flex; gap: 10px;">
                <button id="btn-copy-qr-url" style="
                    flex: 1;
                    padding: 10px 16px;
                    background: linear-gradient(135deg, #6366f1, #ec4899);
                    border: none;
                    border-radius: 10px;
                    color: white;
                    font-weight: 600;
                    cursor: pointer;
                    font-size: 0.85rem;
                ">🔗 Copy Link</button>
                
                <button id="btn-close-qr-modal" style="
                    flex: 1;
                    padding: 10px 16px;
                    background: rgba(255, 255, 255, 0.08);
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 10px;
                    color: white;
                    font-weight: 600;
                    cursor: pointer;
                    font-size: 0.85rem;
                ">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('btn-close-qr-modal').addEventListener('click', () => {
        overlay.remove();
    });

    document.getElementById('btn-copy-qr-url').addEventListener('click', () => {
        navigator.clipboard.writeText(url).then(() => {
            alert('🔗 Room link copied to clipboard!');
        });
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}
