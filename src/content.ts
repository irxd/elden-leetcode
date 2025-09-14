const banners = {
    submissionAccepted: 'banners/submission-accepted.webp',
    submissionRejected: 'banners/submission-rejected.webp'
} as const;

export type Actions = keyof typeof banners

const sounds = {
    victory: 'sounds/victory.mp3',
    youDied: 'sounds/you-died.mp3'
} as const

const bannerSounds: Record<keyof typeof banners, keyof typeof sounds> = {
    submissionAccepted: 'victory',
    submissionRejected: 'youDied'
} as const;

const animations = {
    duration: 1000,
    span: 3500,
    easings: {
        easeOutQuart: 'cubic-bezier(0.25, 1, 0.5, 1)'
    }
} as const

const delays = {
    submissionAccepted: 0,
    submissionRejected: 1000
} as const satisfies Partial<{ [delay in Actions]: number }>

console.log('LeetCode Banner Extension - Content script loaded on:', window.location.href);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    initializeExtension();
}

function initializeExtension() {
    console.log('Extension initialized, DOM ready');
}

chrome.runtime.onMessage.addListener((
    message: { action?: Actions } | undefined, 
    _sender: unknown, 
    sendResponse: (response?: any) => void
) => {
    console.log('Message received in content script:', message);
    
    if (!message?.action) {
        console.log('No action in message');
        sendResponse({ received: false, error: 'No action provided' });
        return false;
    }

    console.log(`Showing banner for action: ${message.action}`);
    try {
        show(message.action);
        sendResponse({ received: true, action: message.action });
    } catch (error) {
        console.error('Error showing banner:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        sendResponse({ received: false, error: errorMessage });
    }
    
    return true;
});

function show(
    action: Actions,
    delay = delays[action as keyof typeof delays] ?? 1000
) {
    console.log(`show() called with action: ${action}, delay: ${delay}`);
    
    if (action in banners === false) {
        console.error(`Invalid action: ${action}`);
        return;
    }

    console.log('Creating banner element...');
    const banner = document.createElement('img');
    const bannerSrc = chrome.runtime.getURL(banners[action]);
    console.log('Banner source URL:', bannerSrc);
    
    banner.src = bannerSrc;
    banner.style.position = 'fixed';
    banner.style.top = '0px';
    banner.style.right = '0px';
    banner.style.zIndex = '99999';
    banner.style.width = '100%';
    banner.style.height = '100vh';
    banner.style.objectFit = 'cover';
    banner.style.objectPosition = 'center';
    banner.style.opacity = '0';
    banner.style.pointerEvents = 'none';
    banner.style.backgroundColor = 'transparent';

    banner.onerror = () => {
        console.error('Failed to load banner image:', bannerSrc);
        const fallbackBanner = document.createElement('div');
        fallbackBanner.style.position = 'fixed';
        fallbackBanner.style.top = '50%';
        fallbackBanner.style.left = '50%';
        fallbackBanner.style.transform = 'translate(-50%, -50%)';
        fallbackBanner.style.zIndex = '99999';
        fallbackBanner.style.padding = '20px';
        fallbackBanner.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
        fallbackBanner.style.color = 'white';
        fallbackBanner.style.fontSize = '24px';
        fallbackBanner.style.borderRadius = '10px';
        fallbackBanner.textContent = action.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
        
        document.body.appendChild(fallbackBanner);
        
        setTimeout(() => {
            fallbackBanner.remove();
        }, 3000);
    };

    banner.onload = () => {
        console.log('Banner image loaded successfully');
    };

    const soundSrc = chrome.runtime.getURL(sounds[bannerSounds[action]]);
    console.log('Sound source URL:', soundSrc);
    
    const audio = new Audio(soundSrc);
    audio.volume = 0.25;

    console.log(`Setting timeout for ${delay}ms before showing banner`);
    
    setTimeout(() => {
        console.log('Showing banner now...');
        
        requestAnimationFrame(() => {
            console.log('Appending banner to body');
            document.body.appendChild(banner);

            banner.animate([{ opacity: 0 }, { opacity: 1 }], {
                duration: animations.duration,
                easing: animations.easings.easeOutQuart,
                fill: 'forwards'
            });

            audio.play().catch((error) => {
                console.log('Could not play sound:', error);
            });
        });
    }, delay);

    setTimeout(() => {
        console.log('Starting banner fade out...');
        
        banner.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: animations.duration,
            easing: animations.easings.easeOutQuart,
            fill: 'forwards'
        });

        setTimeout(() => {
            console.log('Removing banner from DOM');
            banner.remove();
        }, animations.duration);
    }, animations.span + delay);
}