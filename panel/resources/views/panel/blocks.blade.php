@extends('panel.layout')
@section('title', 'مسدودی IP')

@section('main')
    <div class="page">
        <div class="page-head">
            <h1>مسدودی نشانی‌ها</h1>
            <p>نشانی یا محدوده‌ای که اینجا ثبت شود، دیگر به رله‌ی چت (اتصال، ذخیره، گزارش) راه ندارد. نشانی از سرآیند Cloudflare خوانده می‌شود.</p>
        </div>
        @can('blocks.manage')
            <form method="post" action="{{ route('panel.blocks.store') }}" class="card">@csrf
                <div class="row2">
                    <div class="field"><label>IP یا CIDR</label><input class="input ltr" name="cidr" required value="{{ old('cidr') }}" placeholder="203.0.113.7 یا 203.0.113.0/24"></div>
                    <div class="field"><label>مدت (ساعت، خالی = دائمی)</label><input class="input" type="number" name="hours" min="0" max="87600" value="{{ old('hours') }}"></div>
                </div>
                <div class="field"><label>یادداشت</label><input class="input" name="note" maxlength="200" value="{{ old('note') }}" placeholder="دلیل یا شماره‌ی پرونده"></div>
                <button class="btn">@icon('shield') مسدود کن</button>
            </form>
        @endcan
        <div class="table-wrap mt">
            <table>
                <thead><tr><th>نشانی</th><th>یادداشت</th><th>تا</th><th>ثبت توسط</th><th></th></tr></thead>
                <tbody>
                @forelse ($blocks as $b)
                    <tr>
                        <td><code>{{ $b->cidr }}</code></td>
                        <td>{{ $b->note }}</td>
                        <td>@if (! $b->until)<span class="tag red">دائمی</span>@elseif ($b->until->isPast())<span class="tag">منقضی</span>@else{{ $J->format($b->until) }}@endif</td>
                        <td class="small muted">{{ $b->creator?->name }} · {{ $J->format($b->created_at, 'Y/m/d') }}</td>
                        <td>@can('blocks.manage')<form method="post" action="{{ route('panel.blocks.destroy', $b) }}" data-confirm="مسدودی برداشته شود؟">@csrf<button class="icon-btn" title="برداشتن">@icon('trash')</button></form>@endcan</td>
                    </tr>
                @empty
                    <tr><td colspan="5" class="muted">نشانی مسدودی نیست.</td></tr>
                @endforelse
                </tbody>
            </table>
        </div>
    </div>
@endsection
