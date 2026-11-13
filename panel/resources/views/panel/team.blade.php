@extends('panel.layout')
@section('title', 'تیم و نقش‌ها')

@section('main')
    <div class="page">
        <div class="page-head">
            <h1>تیم و نقش‌ها</h1>
            <p>حساب تازه فقط از راه SSH ساخته می‌شود (<code>php artisan nova:user</code>) و فقط ایمیل‌های فهرست <code>NAJVA_ADMINS</code> اجازه‌ی ورود دارند.</p>
        </div>
        <div class="grid two">
            @foreach ($users as $u)
                @php($s = $sessions[$u->id] ?? null)
                <div class="card">
                    <div class="stat">
                        <span class="av t{{ \App\Support\Icons::tone($u->email) }}">{{ mb_substr($u->name, 0, 1) }}</span>
                        <div class="row-main"><b>{{ $u->name }}</b> @if ($u->is(auth()->user()))<span class="tag green">شما</span>@endif<div class="small muted ltr">{{ $u->email }}</div></div>
                    </div>
                    <hr>
                    <div class="svc"><span class="dot {{ $u->isPanelAdmin() ? 'ok' : 'down' }}"></span><span class="row-main">{{ $u->isPanelAdmin() ? 'در فهرست مدیران' : 'در فهرست مدیران نیست (ورود ممکن نیست)' }}</span></div>
                    <div class="svc"><span class="dot {{ $u->two_factor_confirmed_at || $u->passkeys_count ? 'ok' : 'down' }}"></span><span class="row-main">دومرحله‌ای: {{ $u->two_factor_confirmed_at ? 'TOTP' : '' }} {{ $u->passkeys_count ? $J->digits($u->passkeys_count).' passkey' : '' }} {{ ! $u->two_factor_confirmed_at && ! $u->passkeys_count ? 'ندارد' : '' }}</span></div>
                    <div class="svc"><span class="dot"></span><span class="row-main">آخرین ورود: {{ $J->format($u->last_login_at) }} <code>{{ $u->last_login_ip }}</code></span></div>
                    <div class="svc"><span class="dot {{ $s ? 'ok' : '' }}"></span><span class="row-main">نشست فعال: {{ $J->digits($s->n ?? 0) }}</span></div>
                    <form method="post" action="{{ route('panel.team.update', $u) }}" class="btn-row mt">@csrf
                        <select class="input" name="role">@foreach (\App\Support\Perm::ROLES as $k => $l)<option value="{{ $k }}" @selected($u->role === $k)>{{ $l }}</option>@endforeach</select>
                        <button class="btn sm">تغییر نقش</button>
                    </form>
                    <form method="post" action="{{ route('panel.team.sessions', $u) }}" class="mt" data-confirm="همه‌ی نشست‌های این حساب بسته شود؟">@csrf
                        <button class="btn sm ghost">@icon('logout') بستن همه‌ی نشست‌ها</button>
                    </form>
                </div>
            @endforeach
        </div>
        <div class="card mt">
            <h3>@icon('key') دسترسی نقش‌ها</h3>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>کار</th>@foreach (\App\Support\Perm::ROLES as $l)<th>{{ $l }}</th>@endforeach</tr></thead>
                    <tbody>
                    @foreach (['view' => 'دیدن داشبورد و اتاق‌ها', 'rooms.moderate' => 'قطع اتصال و مسدودی اتاق', 'legal.manage' => 'پرونده، توقیف و پایش', 'legal.export' => 'بسته‌ی افشا', 'reports.manage' => 'رسیدگی به گزارش‌ها', 'blocks.manage' => 'مسدودی IP', 'notices.manage' => 'اعلان سراسری', 'audit.view' => 'لاگ ممیزی', 'rooms.destroy' => 'حذف اتاق', 'settings.manage' => 'تنظیمات', 'team.manage' => 'نقش‌ها'] as $a => $label)
                        <tr><td>{{ $label }}</td>@foreach (array_keys(\App\Support\Perm::ROLES) as $r)<td>@if (in_array($r, \App\Support\Perm::ABILITIES[$a], true))<span class="tag green">@icon('check')</span>@else<span class="faint">—</span>@endif</td>@endforeach</tr>
                    @endforeach
                    </tbody>
                </table>
            </div>
        </div>
    </div>
@endsection
