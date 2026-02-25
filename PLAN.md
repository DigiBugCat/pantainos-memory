# Pantainos Memory Frontend - Implementation Plan

## Overview

Adapt the `cloudflare-memory/graph-viewer` frontend for pantainos-memory's epistemological data model. Add derivation subgraph popup on node click.

## Key Model Changes

| Old (cloudflare-memory) | New (pantainos-memory) |
|------------------------|------------------------|
| `Memory` (generic) | `Observation` + `Assumption` |
| `Edge` (strength 1-100) | Derivation DAG (`derived_from`, `violated_by`, `confirmed_by`) |
| `importance` (1-4 tiers) | `confidence` (confirmations/exposures) + `robustness` tier |
| Mutable (edit/delete) | Immutable (retract observations, violate assumptions) |
| Simple CRUD | State machine (active → confirmed/violated/resolved) |

## Architecture

```
pantainos-memory/
├── src/                          # Existing worker code
├── frontend/                     # NEW - React frontend
│   ├── src/
│   │   ├── api/                  # API client layer
│   │   │   ├── client.ts         # Base fetch wrapper
│   │   │   ├── memories.ts       # observe, assume, recall, find
│   │   │   ├── graph.ts          # graph, reference, roots, between
│   │   │   └── insights.ts       # stats, pending, insights views
│   │   ├── components/
│   │   │   ├── Graph/
│   │   │   │   ├── GraphCanvas.tsx
│   │   │   │   ├── graphStyles.ts
│   │   │   │   ├── GraphControls.tsx
│   │   │   │   └── DerivationPopup.tsx  # NEW - subgraph on click
│   │   │   ├── Memory/
│   │   │   │   ├── MemoryPanel.tsx      # Detail panel
│   │   │   │   ├── MemoryForm.tsx       # Create obs/assumption
│   │   │   │   ├── MemoryTypeBadge.tsx  # NEW - obs/assumption badge
│   │   │   │   └── ConfidenceStats.tsx  # NEW - robustness display
│   │   │   ├── Search/
│   │   │   │   ├── SearchBar.tsx
│   │   │   │   └── SearchFilters.tsx    # NEW - type/state filters
│   │   │   └── Layout/
│   │   │       ├── Toolbar.tsx
│   │   │       └── Modal.tsx
│   │   ├── context/
│   │   │   └── GraphContext.tsx
│   │   ├── types/
│   │   │   └── index.ts          # Memory, Observation, Assumption types
│   │   ├── utils/
│   │   │   └── graphTransform.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── tsconfig.json
└── wrangler.toml                 # Add assets binding
```

## Implementation Tasks

### Phase 1: Project Setup

1. **Create frontend directory structure**
   - Copy scaffolding from archive (package.json, vite.config, tailwind.config, tsconfig)
   - Update package name to `@pantainos/memory-viewer`
   - Install dependencies

2. **Configure Vite proxy for development**
   - Proxy `/api/*` to local worker (port 8794)

3. **Add Cloudflare Pages deployment**
   - Configure `wrangler.toml` with `[site]` for static assets
   - OR deploy frontend separately to Pages

### Phase 2: Types & API Layer

4. **Define TypeScript types** (`types/index.ts`)
   ```typescript
   type MemoryType = 'obs' | 'assumption';
   type MemoryState = 'active' | 'confirmed' | 'violated' | 'resolved';
   type RobustnessTier = 'untested' | 'brittle' | 'tested' | 'robust';

   interface Memory {
     id: string;
     memory_type: MemoryType;
     content: string;
     state: MemoryState;
     tags: string[];
     created_at: number;
     // Obs-specific
     source?: 'market' | 'news' | 'earnings' | 'email' | 'human' | 'tool';
     retracted?: boolean;
     // Assumption-specific
     derived_from?: string[];
     invalidates_if?: string[];
     confirms_if?: string[];
     resolves_by?: number;
     outcome_condition?: string;
     // Confidence
     exposures: number;
     confirmations: number;
     centrality: number;
     violations?: Violation[];
   }

   interface GraphEdge {
     source_id: string;
     target_id: string;
     edge_type: 'derived_from' | 'confirmed_by' | 'violated_by';
     strength: number;
   }
   ```

5. **Implement API client** (`api/`)
   - `client.ts` - Base fetch with error handling
   - `memories.ts` - observe(), assume(), recall(), find(), confirm(), violate()
   - `graph.ts` - fetchGraph(), getReference(), getRoots(), getBetween()
   - `insights.ts` - getStats(), getPending(), getInsights()

### Phase 3: Graph Context & State

6. **Update GraphContext** (`context/GraphContext.tsx`)
   - Add `memoryType` filter (obs/assumption/all)
   - Add `stateFilter` (active/confirmed/violated/all)
   - Add `selectedDerivation` for popup subgraph
   - Track `derivationGraph` (nodes/edges for popup)

7. **Update graph transformation** (`utils/graphTransform.ts`)
   - Node color by type: obs = blue, assumption = amber
   - Node border by state: active = none, confirmed = green, violated = red
   - Node size by confidence (exposures * confirmation rate)
   - Edge style by type: derived_from = solid, violated_by = dashed red

### Phase 4: Core Components

8. **GraphCanvas updates**
   - On single click: select node, show MemoryPanel
   - On click (with popup): fetch `/api/reference/:id?direction=up&depth=2`, show DerivationPopup
   - Support shift+click for multi-select

9. **NEW: DerivationPopup component**
   - Mini Cytoscape canvas showing derivation subgraph
   - Centered on clicked node
   - Shows 2 hops up (what this is derived from)
   - Click node in popup → navigate to it in main graph
   - Positioned near clicked node (floating)

10. **MemoryPanel updates**
    - Show type badge (observation/assumption)
    - Show source for observations
    - Show `derived_from` list with links for assumptions
    - Show `invalidates_if` / `confirms_if` conditions
    - Show confidence stats (exposures, confirmations, robustness tier)
    - Show violations history if any
    - Actions: Confirm, Violate, Retract (obs only)

11. **MemoryForm updates**
    - Toggle between Create Observation / Create Assumption
    - Observation: content, source (dropdown), tags
    - Assumption: content, derived_from (multi-select), invalidates_if (list), tags
    - Optional: resolves_by date picker, outcome_condition

12. **SearchBar updates**
    - Add type filter chips (All / Observations / Assumptions)
    - Add state filter (Active / Confirmed / Violated)
    - Show confidence in results

### Phase 5: Styling & Polish

13. **Update graphStyles.ts**
    ```typescript
    // Node colors by type
    'node.obs': { 'background-color': '#3b82f6' }      // blue
    'node.assumption': { 'background-color': '#f59e0b' } // amber

    // State borders
    'node.confirmed': { 'border-color': '#22c55e', 'border-width': 3 }
    'node.violated': { 'border-color': '#ef4444', 'border-width': 3 }

    // Edge types
    'edge.derived_from': { 'line-style': 'solid', 'target-arrow-shape': 'triangle' }
    'edge.violated_by': { 'line-style': 'dashed', 'line-color': '#ef4444' }
    ```

14. **Update CSS variables**
    - Add type colors to theme
    - Add state indicator colors
    - Add robustness tier colors (untested=gray, brittle=yellow, tested=blue, robust=green)

15. **Add keyboard shortcuts**
    - `O` - Create observation
    - `A` - Create assumption
    - `D` - Toggle derivation popup
    - `F` - Fit graph
    - `Escape` - Close panels/popups

### Phase 6: Deployment

16. **Configure static asset serving**
    - Option A: Serve from worker (add `[site]` to wrangler.toml)
    - Option B: Deploy to Cloudflare Pages separately

17. **Build script**
    - `pnpm build:frontend` - Build Vite app to `dist/frontend`
    - `pnpm build` - Build worker + frontend

## DerivationPopup - Detailed Design

```
┌─────────────────────────────────────────────┐
│  Derived From                          [×]  │
├─────────────────────────────────────────────┤
│                                             │
│         [obs-abc]                           │
│            │                                │
│            ▼                                │
│      [assumption-def]                       │
│            │                                │
│            ▼                                │
│     ★ [clicked-node]                        │
│                                             │
└─────────────────────────────────────────────┘
```

- Triggered on node click (not double-click - that's for zoom)
- Fetches `/api/reference/:id?direction=up&depth=2`
- Renders mini Cytoscape with concentric layout (clicked node at center)
- Each node shows truncated content on hover
- Click any node to select it in main graph + close popup
- Close button or click outside to dismiss

## API Endpoints Used

| Frontend Action | API Endpoint |
|-----------------|--------------|
| Load full graph | `GET /api/graph` |
| Search | `POST /api/find` |
| Get memory details | `GET /api/recall/:id` |
| Get derivation subgraph | `GET /api/reference/:id?direction=up` |
| Trace to roots | `GET /api/roots/:id` |
| Create observation | `POST /api/observe` |
| Create assumption | `POST /api/assume` |
| Confirm memory | `POST /api/confirm/:id` |
| Violate memory | `POST /api/violate/:id` |
| Retract observation | `POST /api/retract/:id` |
| Get stats | `GET /api/stats` |
| Get pending predictions | `GET /api/pending` |
| Get insights view | `GET /api/insights/:view` |

## Timeline Estimate

- Phase 1-2: Setup + Types + API (foundation)
- Phase 3-4: Context + Core Components (main work)
- Phase 5: Styling (polish)
- Phase 6: Deployment (final)

## Open Questions

1. **Popup trigger**: Single click vs dedicated button vs hover?
   - Recommendation: Single click shows popup, double-click zooms to node

2. **Graph loading**: Load all vs paginated vs on-demand?
   - Current `/api/graph` returns up to 1000 memories
   - For larger graphs, may need viewport-based loading

3. **Real-time updates**: WebSocket vs polling vs manual refresh?
   - Start with manual refresh, add WebSocket later if needed
