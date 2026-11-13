@extends('panel.layout')
@section('title', 'لاگ ممیزی')

@section('main')
    <div class="page">
        <div class="page-head">
            <h1>لاگ ممیزی</h1>
            <form method="post" action="{{ route('panel.audit.verify') }}">@csrf<button class="btn sm ghost">@icon('fingerprint') بررسی یکپارچگی</button></form>
            <a class="btn sm ghost" href="{{ route('panel.audit.csv') }}">@icon('download') خروجی CSV</a>
            <p>هر کار مدیران با زمان، نشانی و مرورگر ثبت می‌شود. ردیف‌ها زنجیره‌ی هش (HMAC) دارند: حذف یا ویرایش هر ردیف، زنجیره را از همان‌جا می‌شکند.</p>
        </div>
        @if ($verify)
            @if ($verify['ok'])
                <div class="alert-box ok">@icon('check')<div>زنجیره سالم است: {{ $J->digits($verify['checked']) }} ردیف بررسی شد.@if ($verify['unhashed']) ({{ $J->digits($verify['unhashed']) }} ردیف قدیمی پیش از زنجیره) @endif</div></div>
            @else
                <div class="alert-box danger">@icon('alert')<div><b>زنجیره شکسته است</b> از ردیف #{{ $J->digits($verify['broken']) }}. این یعنی لاگ پس از ثبت دستکاری یا حذف شده است.</div></div>
            @endif
        @endif
        <form class="btn-row" method="get">
            <input class="input narrow" name="q" value="{{ request('q') }}" placeholder="ایمیل، کار، هدف یا IP">
            @foreach (['' => 'همه', 'security' => 'امنیت', 'legal' => 'حقوقی', 'rooms' => 'اتاق‌ها'] as $k => $l)
                <a class="chip {{ request('k', '') === $k ? 'on' : '' }}" href="{{ route('panel.audit', array_filter(['k' => $k, 'q' => request('q')])) }}">{{ $l }}</a>
            @endforeach
            <button class="btn sm">جستجو</button>
        </form>
        <div class="table-wrap mt">
            <table>
                <thead><tr><th>#</th><th>زمان</th><th>مدیر</th><th>کار</th><th>هدف</th><th>جزئیات</th><th>IP</th></tr></thead>
                <tbody>
                @foreach ($logs as $l)
                    @php($bad = str_contains($l->action, 'failed') || in_array($l->action, ['lockout', 'access.denied', 'session.mismatch', 'stepup.locked'], true))
                    <tr>
                        <td class="faint">{{ $J->digits($l->id) }}</td>
                        <td class="small">{{ $J->format($l->created_at, 'Y/m/d H:i:s') }}</td>
                        <td class="small">{{ $l->email ?? '—' }}</td>
                        @php([$al, $ai] = \App\Models\AdminLog::label($l->action))
                        <td><span class="tag {{ $bad ? 'red' : (str_starts_with($l->action, 'room.') || str_starts_with($l->action, 'export') || str_starts_with($l->action, 'case') ? 'blue' : '') }}">@icon($ai){{ $al }}</span> <code class="faint small">{{ $l->action }}</code></td>
                        <td><code>{{ $l->target }}</code></td>
                        <td class="small muted"><code>{{ \Illuminate\Support\Str::limit(json_encode($l->detail, JSON_UNESCAPED_UNICODE), 80) }}</code></td>
                        <td><code>{{ $l->ip }}</code></td>
                    </tr>
                @endforeach
                </tbody>
            </table>
        </div>
        @if ($logs->hasPages())
            <div class="pager">
                @if ($logs->previousPageUrl())<a href="{{ $logs->previousPageUrl() }}">قبلی</a>@endif
                <span class="on">{{ $J->digits($logs->currentPage()) }} / {{ $J->digits($logs->lastPage()) }}</span>
                @if ($logs->nextPageUrl())<a href="{{ $logs->nextPageUrl() }}">بعدی</a>@endif
            </div>
        @endif
    </div>
@endsection
