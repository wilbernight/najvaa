@php($pct = max(0, min(100, (float) $pct)))
<svg class="bar-svg" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
    <rect x="0" y="0" width="100" height="8" rx="4" class="bar-bg"/>
    <rect x="{{ 100 - $pct }}" y="0" width="{{ $pct }}" height="8" rx="4" class="bar-fg {{ $pct > 90 ? 'full' : ($pct > 75 ? 'hot' : '') }}"/>
</svg>
