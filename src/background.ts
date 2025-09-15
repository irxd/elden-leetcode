import type { Actions } from './content';

declare const chrome: {
    webRequest: {
        onBeforeRequest: {
            addListener: (
                callback: (details: WebRequestDetails) => void,
                filter: { urls: string[] },
                extraInfoSpec: string[]
            ) => void;
        };
        onCompleted: {
            addListener: (
                callback: (details: WebRequestDetails & { responseHeaders?: Array<{name: string, value?: string}> }) => void,
                filter: { urls: string[] },
                extraInfoSpec: string[]
            ) => void;
        };
        onBeforeResponse: {
            addListener: (
                callback: (details: WebRequestDetails & { responseHeaders?: Array<{name: string, value?: string}> }) => void,
                filter: { urls: string[] },
                extraInfoSpec: string[]
            ) => void;
        };
    };
    tabs: {
        get: (tabId: number, callback: (tab: chrome.tabs.Tab) => void) => void;
        sendMessage: (tabId: number, message: { action: Actions }, callback?: (response?: any) => void) => void;
        query: (queryInfo: chrome.tabs.QueryInfo, callback: (result: chrome.tabs.Tab[]) => void) => void;
    };
    runtime: {
        lastError?: { message?: string };
        onMessage: {
            addListener: (callback: (
                message: any,
                sender: chrome.runtime.MessageSender,
                sendResponse: (response?: any) => void
            ) => void) => void;
        };
    };
    scripting: {
        executeScript: (details: { target: { tabId: number }, files?: string[], func?: () => any }, callback?: (result: any[]) => void) => void;
    };
};

interface WebRequestDetails {
    url: string;
    method: string;
    tabId: number;
    requestBody?: {
        raw?: Array<{ bytes?: Uint8Array }>;
        formData?: { [key: string]: string[] };
    };
    responseHeaders?: Array<{name: string, value?: string}>;
}

const pendingSubmissions = new Map<number, { 
    timestamp: number, 
    submissionId?: string, 
    retryCount?: number,
    hasDispatched?: boolean 
}>();

const code = {
    ACCEPTED: 10,
    RUNTIME_ERROR: 15,
    MEMORY_LIMIT_EXCEEDED: 12,
    TIME_LIMIT_EXCEEDED: 14
}

async function dispatch(action: Actions, details: WebRequestDetails): Promise<void> {
    const tabId = details.tabId;
    if (typeof tabId !== 'number' || !tabId) return;
    
    try {
        const tab = await new Promise<chrome.tabs.Tab | undefined>((resolve) => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError) {
                    console.error('Error getting tab:', chrome.runtime.lastError);
                    resolve(undefined);
                } else {
                    resolve(tab);
                }
            });
        });

        if (!tab || !tab.active) {
            console.error(`Tab ${tabId} is not active or no longer exists`);
            return;
        }

        const sendMessage = (retryCount = 0) => {
            try {
                chrome.tabs.sendMessage(tabId, { action }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('Error sending message:', chrome.runtime.lastError);
                        
                        if (retryCount < 2) { 
                            const delay = Math.pow(2, retryCount) * 1000;
                            setTimeout(() => sendMessage(retryCount + 1), delay);
                        } else {
                            console.error('Max retries reached for tab', tabId);
                            injectContentScript(tabId, action);
                        }
                    }
                });
            } catch (error) {
                console.error('Error in dispatch:', error);
            }
        };
        
        sendMessage(0);
    } catch (error) {
        console.error('Error in dispatch:', error);
    }
}

async function injectContentScript(tabId: number, action: Actions) {
    try {
        await new Promise<void>((resolve, reject) => {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        chrome.tabs.sendMessage(tabId, { action }, () => {
            if (chrome.runtime.lastError) {
                console.error('Still failed to send message after injection:', chrome.runtime.lastError);
            }
        });
    } catch (error) {
        console.error('Error injecting content script:', error);
        
        try {
            await new Promise<void>((resolve, reject) => {
                chrome.scripting.executeScript({
                    target: { tabId }
                }, () => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve();
                    }
                });
            });
            
            chrome.tabs.sendMessage(tabId, { action }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Still failed after fallback injection:', chrome.runtime.lastError);
                }
            });
        } catch (fallbackError) {
            console.error('Fallback injection also failed:', fallbackError);
        }
    }
}

function readBody(detail: WebRequestDetails): any {
    if (detail.method !== 'POST') return null;

    if (detail.requestBody?.formData) {
        return detail.requestBody.formData;
    }

    const bytes = detail.requestBody?.raw?.[0]?.bytes;
    if (!bytes) return null;

    const decoder = new TextDecoder('utf-8');
    const jsonStr = decoder.decode(bytes);

    try {
        return JSON.parse(jsonStr);
    } catch {
        return jsonStr;
    }
}

const matchLeetCodeGraphQL = (detail: WebRequestDetails, operationName: string): boolean => {
    if (detail.url !== 'https://leetcode.com/graphql') return false;
    if (detail.method !== 'POST') return false;

    const body = readBody(detail);
    
    if (body && typeof body === 'object' && 'query' in body) {
        const query = Array.isArray(body.query) ? body.query[0] : body.query;
        return typeof query === 'string' && query.includes(operationName);
    }
    
    if (body && typeof body === 'object' && 'operationName' in body) {
        return body.operationName === operationName;
    }

    return false;
};

async function fetchSubmissionResult(submissionId: string, tabId: number): Promise<void> {
    try {
        const pending = pendingSubmissions.get(tabId);
        if (pending?.hasDispatched) {
            return;
        }

        const url = `https://leetcode.com/submissions/detail/${submissionId}/check/`;
        
        const response = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; LeetCode Extension)' }
        });
        
        if (!response.ok) {
            console.error(`Failed to fetch submission result: ${response.status}`);
            return;
        }
        
        const data = await response.json();
        const status = data.state;
        const statusCode = data.status_code;

        let action: Actions | null = null;
        
        if (status === 'SUCCESS') {
            if (statusCode === code.ACCEPTED) {
                action = 'submissionAccepted';
            } else if (statusCode === code.RUNTIME_ERROR) {
                action = 'submissionRuntimeError';
            } else if (statusCode === code.MEMORY_LIMIT_EXCEEDED) {
                action = 'submissionMemoryLimit';
            } else if (statusCode === code.TIME_LIMIT_EXCEEDED) {
                action = 'submissionTimeLimit';
            } else {
                action = 'submissionRejected';
            }
        }

        if (action) {
            const pending = pendingSubmissions.get(tabId);
            if (pending && !pending.hasDispatched) {
                pending.hasDispatched = true;
                dispatch(action, { url: '', method: 'POST', tabId });
                pendingSubmissions.set(tabId, pending);
            }
        } else {
            const pending = pendingSubmissions.get(tabId);
            if (pending) {
                const retryCount = (pending.retryCount || 0) + 1;
                if (retryCount < 30) { 
                    pending.retryCount = retryCount;
                    pendingSubmissions.set(tabId, pending);
                    
                    const delay = Math.min(retryCount * 1000, 5000); 
                    setTimeout(() => fetchSubmissionResult(submissionId, tabId), delay);
                } else {
                    pendingSubmissions.delete(tabId);
                }
            }
        }
        
    } catch (error) {
        console.error('Error fetching submission result:', error);
        const pending = pendingSubmissions.get(tabId);
        if (pending) {
            const retryCount = (pending.retryCount || 0) + 1;
            if (retryCount < 3) {
                 pending.retryCount = retryCount;
                 pendingSubmissions.set(tabId, pending);
                 setTimeout(() => fetchSubmissionResult(submissionId, tabId), 3000);
            } else {
                 pendingSubmissions.delete(tabId);
            }
        }
    }
}
function extractSubmissionId(url: string): string | null {
    const match = url.match(/\/submissions\/detail\/(\d+)\/check\//);
    return match ? match[1] : null;
}

chrome.webRequest.onBeforeRequest.addListener(
    (detail: WebRequestDetails) => {        
        if (detail.url === 'https://leetcode.com/graphql') {   
            if (matchLeetCodeGraphQL(detail, 'submitCode')) {
                pendingSubmissions.set(detail.tabId, { timestamp: Date.now(), retryCount: 0, hasDispatched: false });
                return;
            }

            if (matchLeetCodeGraphQL(detail, 'checkin')) {
                dispatch('dailyCheckin', detail);
                return;
            }
        }
        
        if (detail.url.includes('leetcode.com') && detail.url.includes('submit') && 
            detail.method === 'POST' && !detail.url.includes('/check/')) {
            pendingSubmissions.set(detail.tabId, { timestamp: Date.now(), retryCount: 0, hasDispatched: false });
            return;
        }
    },
    { urls: ['https://leetcode.com/*'] },
    ['requestBody']
);

chrome.webRequest.onCompleted.addListener(
    (detail: WebRequestDetails) => {
        if (detail.url.includes('leetcode.com/submissions/detail/') && detail.url.includes('/check/')) {
            const submissionId = extractSubmissionId(detail.url);
            if (submissionId && pendingSubmissions.has(detail.tabId)) {
                const pending = pendingSubmissions.get(detail.tabId);
                if (pending) {
                    pending.submissionId = submissionId;
                    pendingSubmissions.set(detail.tabId, pending);
                }
                
                setTimeout(() => {
                    fetchSubmissionResult(submissionId, detail.tabId);
                }, 1000);
            }
        }
    },
    { urls: ['https://leetcode.com/*'] },
    ['responseHeaders']
);

chrome.webRequest.onBeforeResponse?.addListener(
    (detail: WebRequestDetails) => {
        if (detail.url.includes('leetcode.com/submissions/detail/') && detail.url.includes('/check/')) {
            const submissionId = extractSubmissionId(detail.url);
            if (submissionId && pendingSubmissions.has(detail.tabId)) {                
                setTimeout(() => {
                    chrome.scripting.executeScript({
                        target: { tabId: detail.tabId },
                        func: () => {
                            return {
                                url: window.location.href,
                                body: document.body.textContent
                            };
                        }
                    });
                }, 500);
            }
        }
    },
    { urls: ['https://leetcode.com/*'] },
    ['responseHeaders']
);

setInterval(() => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [tabId, submission] of pendingSubmissions.entries()) {
        if (submission.timestamp < fiveMinutesAgo) {
            pendingSubmissions.delete(tabId);
        }
    }
}, 60000); 