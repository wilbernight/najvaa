@extends('panel.layout')
@section('title', 'اعلان سراسری')

@section('main')
    <div class="page">
        <div class="page-head">
            <h1>اعلان سراسری</h1>
            <p>یک پیام کوتاه که همان لحظه در همه‌ی اپ‌های باز و برای هر دستگاهی که بعداً وصل شود نمایش داده می‌شود (مثلاً قطعی برنامه‌ریزی‌شده یا تغییر قوانین).</p>
        </div>
        @php($active = $notices->first(fn ($n) => $n->active()))
        @if ($active)
            <div class="alert-box {{ $active->level === 'alert' ? 'danger' : ($active->level === 'warn' ? 'warn' : '') }}">@icon('megaphone')
                <div class="row-main"><b>فعال:</b> {{ $active->text }}<div class="small muted">{{ $active->until ? 'تا '.$J->format($active->until) : 'بدون پایان' }}</div></div>
                @can('notices.manage')<form method="post" action="{{ route('panel.notices.clear') }}">@csrf<button class="btn sm ghost">برداشتن</button></form>@endcan
            </div>
        @endif
        @can('notices.manage')
            <form method="post" action="{{ route('panel.notices.store') }}" class="card">@csrf
                <div class="field"><label>متن اعلان</label><textarea class="input" name="text" required maxlength="500">{{ old('text') }}</textarea></div>
                <div class="row2">
                    <div class="field"><label>نوع</label><select class="input" name="level">@foreach (\App\Models\ServiceNotice::LEVELS as $k => $l)<option value="{{ $k }}">{{ $l }}</option>@endforeach</select></div>
                    <div class="field"><label>مدت (ساعت، خالی = تا برداشتن)</label><input class="input" type="number" name="hours" min="0" max="720"></div>
                </div>
                <button class="btn">@icon('send') فرستادن برای همه</button>
            </form>
        @endcan
        <h3 class="mt">تاریخچه</h3>
        @foreach ($notices as $n)
            <div class="bubble {{ $n->active() ? 'out' : '' }}">
                <div class="body">{{ $n->text }}</div>
                <div class="meta">{{ \App\Models\ServiceNotice::LEVELS[$n->level] ?? $n->level }} · {{ $J->digits($n->sent_to) }} دستگاه · {{ $n->creator?->name }} · {{ $J->format($n->created_at) }}</div>
            </div>
        @endforeach
    </div>
@endsection
