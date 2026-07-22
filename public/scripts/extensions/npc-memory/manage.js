/**
 * Long-term memory manager for the NPC Memory consumer.
 *
 * A small interactive popup that lists each NPC's durable long-term memories and
 * lets the user delete individual entries (or clear an NPC's whole set). This is
 * the manual escape hatch for the times a stored memory no longer fits the
 * story — after editing a message, undoing an exchange, or branching the chat
 * from an earlier point. Working-memory slots are intentionally left alone; they
 * roll over on their own each turn, whereas long-term memories persist until
 * something removes them.
 */

import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import { allRecords, removeLongTerm, clearLongTerm, saveNow } from './store.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Open the long-term memory manager popup for the current chat.
 * @returns {Promise<void>}
 */
export async function openMemoryManager() {
    const container = document.createElement('div');
    container.className = 'npcmem-manage';
    container.style.textAlign = 'left';

    // Re-render the whole list from the live store after every mutation, so
    // counts, section visibility, and the empty state all stay in sync.
    const render = () => {
        container.innerHTML = '';

        const heading = document.createElement('h3');
        heading.textContent = 'NPC long-term memory';
        container.appendChild(heading);

        const intro = document.createElement('p');
        intro.className = 'npcmem-manage-intro';
        intro.textContent =
            'Delete durable memories that no longer fit the story — after editing a message, ' +
            'undoing an exchange, or branching the chat. Changes apply to this chat and take ' +
            'effect on the next message.';
        container.appendChild(intro);

        const records = allRecords();
        const withMem = Object.values(records ?? {})
            .filter(r => Array.isArray(r.longTerm) && r.longTerm.length > 0)
            .sort((a, b) => String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)));

        if (withMem.length === 0) {
            const empty = document.createElement('p');
            empty.innerHTML = '<em>No long-term memories are stored for this chat.</em>';
            container.appendChild(empty);
            return;
        }

        for (const rec of withMem) container.appendChild(buildNpcSection(rec, render));
    };

    render();
    await callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

/**
 * Build one NPC block: a header (name, id, count, "clear all") plus its entries.
 * @param {import('./store.js').NpcRecord} rec
 * @param {() => void} render  Re-render callback for after a mutation.
 * @returns {HTMLElement}
 */
function buildNpcSection(rec, render) {
    const section = document.createElement('div');
    section.className = 'npcmem-manage-npc';

    const header = document.createElement('div');
    header.className = 'npcmem-manage-npc-header';

    const title = document.createElement('div');
    title.className = 'npcmem-manage-npc-title';
    title.innerHTML =
        `<b>${esc(rec.displayName || rec.id)}</b> ` +
        `<small class="opacity50p">${esc(rec.id)}</small> · ` +
        `<small>${rec.longTerm.length} ${rec.longTerm.length === 1 ? 'memory' : 'memories'}</small>`;

    const clearBtn = document.createElement('div');
    clearBtn.className = 'menu_button menu_button_icon npcmem-manage-clear';
    clearBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i><span>Clear all</span>';
    clearBtn.addEventListener('click', async () => {
        const ok = await callGenericPopup(
            `Delete all ${rec.longTerm.length} long-term memories for ${esc(rec.displayName || rec.id)}?`,
            POPUP_TYPE.CONFIRM,
        );
        if (!ok) return;
        clearLongTerm(rec.id);
        await saveNow();
        render();
    });

    header.appendChild(title);
    header.appendChild(clearBtn);
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'npcmem-manage-list';
    // Newest first — the entries most likely to be the ones just invalidated.
    const entries = rec.longTerm.slice().sort((a, b) => (b?.ts || 0) - (a?.ts || 0));
    for (const entry of entries) list.appendChild(buildEntryRow(rec, entry, render));
    section.appendChild(list);

    return section;
}

/**
 * Build one deletable memory row (delete button + text + timestamp/source).
 * @param {import('./store.js').NpcRecord} rec
 * @param {{ ts:number, text:string, source?:string }} entry
 * @param {() => void} render
 * @returns {HTMLElement}
 */
function buildEntryRow(rec, entry, render) {
    const row = document.createElement('div');
    row.className = 'npcmem-manage-entry';

    const del = document.createElement('div');
    del.className = 'npcmem-manage-del menu_button menu_button_icon';
    del.title = 'Delete this memory';
    del.setAttribute('aria-label', 'Delete this memory');
    del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    del.addEventListener('click', async () => {
        removeLongTerm(rec.id, entry.ts, entry.text);
        await saveNow();
        render();
    });

    const body = document.createElement('div');
    body.className = 'npcmem-manage-entry-body';

    const text = document.createElement('div');
    text.className = 'npcmem-manage-entry-text';
    text.textContent = entry.text;

    const meta = document.createElement('div');
    meta.className = 'npcmem-manage-entry-meta opacity50p';
    const when = entry.ts ? new Date(entry.ts).toLocaleString() : 'unknown time';
    meta.textContent = entry.source ? `${when} · ${entry.source}` : when;

    body.appendChild(text);
    body.appendChild(meta);
    row.appendChild(del);
    row.appendChild(body);
    return row;
}
