@extends('panel.layout')
@section('title', 'اتاق '.$J->digits($room->label))
@section('bodyClass', 'has-detail')

@php
    $tone = \App\Support\Icons::tone($room->room_id);
    $tab = request('tab', 'items');
    $flags = $meta['flags'] ?? ($room->flags ?? []);
    $live = count($meta['live'] ?? []) ?: $room->online;
    $caseOptions = $openCases->map(fn ($c) => ['id' => $c->id, 'label' => $c->ref.' — '.\Illuminate\Support\Str::limit($c->subject, 40)]);
@endphp

@section('list')
    @include('panel.partials.room-list')
@endsection

@section('main')
    <header class="chat-head">
        <a class="icon-btn back-btn" href="{{ route('panel.rooms', request()->only('f')) }}" aria-label="بازگشت">@icon('back')</a>
        <span class="av sm t{{ $tone }}">{{ $room->code ? $J->digits(substr($room->code, 0, 3)) : '؟' }}@if ($live)<i class="online-dot"></i>@endif</span>
        <div class="title">
            <b>اتاق {{ $J->digits($room->label) }}</b>
            <span class="{{ $live ? 'on' : '' }}">
                @if ($room->suspended) مسدود شده
                @elseif ($live) {{ $J->digits($live) }} دستگاه آنلاین
                @else آخرین فعالیت {{ $J->ago($room->last_activity_at) }}
                @endif
            </span>
        </div>
        <div class="head-actions">
            <a class="icon-btn {{ $tab === 'items' ? 'on' : '' }}" href="{{ route('panel.rooms.show', [$room, 'tab' => 'items'] + request()->only('f')) }}" title="موارد ذخیره‌شده">@icon('archive')</a>
            @can('legal.view')
                <a class="icon-btn" href="{{ route('panel.rooms.show', [$room, 'tab' => 'conn'] + request()->only('f')) }}" title="ثبت اتصال‌ها">@icon('globe')</a>
            @endcan
            <button type="button" class="icon-btn hide-wide" data-toggle-info title="اطلاعات و اقدامات">@icon('more')</button>
        </div>
    </header>

    @if ($tab === 'conn' && Gate::allows('legal.view'))
        <div class="page">
            <div class="page-head">
                <h1>ثبت اتصال‌ها</h1>
                <p>فقط وقتی اتاق تحت پایش یک پرونده است ثبت می‌شود. زمان‌ها به وقت تهران است. دیدن این صفحه در لاگ ممیزی ثبت می‌شود.</p>
            </div>
            @if ($conn)
                <div class="table-wrap">
                    <table>
                        <thead><tr><th>زمان</th><th>رویداد</th><th>IP</th><th>کشور</th><th>دستگاه</th><th>مرورگر / برنامه</th><th>مدت</th><th>پرونده</th></tr></thead>
                        <tbody>
                        @foreach ($conn as $c)
                            @php($ev = ['join' => ['ورود', 'green'], 'create' => ['ساخت', 'green'], 'leave' => ['خروج', ''], 'refused' => ['رد شد', 'red'], 'store' => ['ارسال پیام', 'blue'], 'upload' => ['ارسال فایل', 'blue'], 'del' => ['حذف', 'amber'], 'clear' => ['پاک‌کردن همه', 'amber'], 'exp' => ['زمان‌دار کردن حذف', 'amber']][$c['ev'] ?? ''] ?? [$c['ev'] ?? '?', ''])
                            <tr class="conn-row">
                                <td>{{ $J->format($c['ts'] ?? null, 'Y/m/d H:i:s') }}</td>
                                <td><span class="tag {{ $ev[1] }}">{{ $ev[0] }}</span></td>
                                <td><code>{{ $c['ip'] ?? '' }}</code></td>
                                <td>{{ $c['cc'] ?? '' }}</td>
                                <td><code>{{ $c['cid'] ?? '' }}</code></td>
                                <td class="small muted"><span class="ltr">{{ \Illuminate\Support\Str::limit($c['ua'] ?? '', 70) }}</span></td>
                                <td>{{ isset($c['secs']) ? $J->digits(gmdate($c['secs'] >= 3600 ? 'H:i:s' : 'i:s', (int) $c['secs'])) : '' }}</td>
                                <td><code>{{ $c['case'] ?? '' }}</code></td>
                            </tr>
                        @endforeach
                        </tbody>
                    </table>
                </div>
            @else
                <div class="alert-box">@icon('info')<div>برای این اتاق هیچ اتصالی ثبت نشده است. ثبت اتصال فقط با «پایش» از طریق یک پرونده‌ی حقوقی روشن می‌شود.</div></div>
            @endif
        </div>
    @else
        <div class="wall" data-bottom>
            @if ($error)
                <div class="bubble sys alert">{{ $error }}</div>
            @endif
            <div class="bubble sys">
                @icon('lock', 'ic small') محتوای این گفتگو رمزنگاری سرتاسری است. اینجا فقط زمان، نوع و حجم هر مورد دیده می‌شود.
            </div>
            @if ($meta && $meta['created'])
                <div class="day"><span>{{ $J->format($meta['created'], 'j F Y') }}</span></div>
                <div class="bubble sys">اتاق ساخته شد · {{ $J->format($meta['created'], 'H:i') }}</div>
            @endif
            @forelse ($timeline as $day => $items)
                @if (! ($loop->first && $meta && $meta['created'] && $J->format($meta['created'], 'j F Y') === $day))
                    <div class="day"><span>{{ $day }}</span></div>
                @endif
                @foreach ($items as $e)
                    <div class="bubble {{ $e['state'] === 'held' ? 'held' : '' }}">
                        <div class="cipher">
                            @icon($e['blob'] ? 'file' : 'lock')
                            <div>
                                <div>{{ $e['blob'] ? 'فایل رمزشده' : 'پیام رمزشده' }} · {{ $J->bytes($e['size']) }}@if ($e['blob'] && ($e['chunks'] ?? 0)) · {{ $J->digits($e['chunks']) }} تکه @endif</div>
                                <div class="bar">{{ substr(base64_encode(hash('sha256', $e['id'], true)), 0, 28) }}</div>
                                @if ($e['state'] === 'held')
                                    <div class="small blue-text">حذف‌شده توسط کاربر · حفظ‌شده به دستور حقوقی در {{ $J->format($e['retired'] ?? null) }}</div>
                                @elseif ($e['exp'])
                                    <div class="small muted">@icon('clock', 'ic') حذف خودکار {{ $J->ago($e['exp']) }}</div>
                                @endif
                            </div>
                        </div>
                        <div class="meta"><code>{{ $e['id'] }}</code> · {{ $J->format($e['ts'], 'H:i') }} @icon('checks')</div>
                    </div>
                @endforeach
            @empty
                @if ($meta)
                    <div class="bubble sys">چیزی در این اتاق ذخیره نشده است.</div>
                @endif
            @endforelse
            <div id="end"></div>
        </div>
    @endif
@endsection

@section('info')
    <div class="info-head">
        <span class="av lg t{{ $tone }}">{{ $room->code ? $J->digits(substr($room->code, 0, 3)) : '؟' }}</span>
        <h2>{{ $J->digits($room->label) }}</h2>
        <div class="muted">{{ $live ? $J->digits($live).' دستگاه آنلاین' : 'آفلاین' }}</div>
        <div class="btn-row center mt-s">
            @if ($room->hold)<span class="tag blue">@icon('lock') توقیف · {{ $flags['hold']['case'] ?? '' }}</span>@endif
            @if ($room->suspended)<span class="tag red">@icon('ban') مسدود</span>@endif
            @if ($room->watched())<span class="tag amber">@icon('eye') پایش تا {{ $J->format($room->watch_until, 'm/d') }}</span>@endif
        </div>
    </div>

    <div class="info-sec">
        <h3>اطلاعات</h3>
        <div class="kv">@icon('key')<div><b class="mono xs">{{ $room->room_id }}</b><small>شناسه‌ی اتاق (HKDF کد؛ رمز اتاق هرگز به سرور نمی‌رسد)</small></div><button type="button" class="icon-btn" data-copy="{{ $room->room_id }}" title="کپی">@icon('file')</button></div>
        <div class="kv">@icon('clock')<div><b>{{ $J->format($meta['created'] ?? $room->remote_created_at) }}</b><small>ساخت</small></div></div>
        <div class="kv">@icon('refresh')<div><b>{{ $J->format($room->last_activity_at) }}</b><small>آخرین مورد ذخیره‌شده</small></div></div>
        <div class="kv">@icon('archive')<div><b>{{ $J->digits(count($meta['entries'] ?? []) ?: $room->items) }} مورد · {{ $J->digits($room->files) }} فایل · {{ $J->bytes($meta['bytes'] ?? $room->bytes) }}</b><small>ذخیره‌شده روی سرور</small></div></div>
        @if (($meta['held'] ?? []) || $room->held_items)
            <div class="kv">@icon('lock')<div><b>{{ $J->digits(count($meta['held'] ?? []) ?: $room->held_items) }} مورد</b><small>حذف‌شده توسط کاربر و حفظ‌شده (توقیف)</small></div></div>
        @endif
        @if ($meta['live'] ?? [])
            <div class="kv">@icon('device')<div><b class="mono">{{ implode('، ', $meta['live']) }}</b><small>شناسه‌ی دستگاه‌های وصل</small></div></div>
        @endif
    </div>

    @can('legal.view')
        <div class="info-sec">
            <h3>پرونده‌های مرتبط</h3>
            @forelse ($links as $l)
                <a class="row" href="{{ route('panel.cases.show', $l->legalCase) }}">
                    <span class="av sm t{{ \App\Support\Icons::tone($l->legalCase->ref) }}">@icon('scale')</span>
                    <span class="row-main"><span class="row-title">{{ $l->legalCase->ref }}</span><span class="row-sub">{{ \App\Models\LegalCase::STATUSES[$l->legalCase->status] }} · {{ \Illuminate\Support\Str::limit($l->legalCase->subject, 30) }}</span></span>
                </a>
            @empty
                <div class="muted small">به هیچ پرونده‌ای پیوند ندارد.</div>
            @endforelse
            @can('legal.manage')
                <a class="act good" href="{{ route('panel.cases.create', ['code' => $room->code]) }}">@icon('plus')<span>پرونده‌ی تازه برای این اتاق</span></a>
            @endcan
        </div>
    @endcan

    <div class="info-sec">
        <h3>اقدامات</h3>
        @can('legal.manage')
            @if ($room->hold)
                <button class="act blue" data-dialog="dlg-release">@icon('lock')<span>برداشتن حفظ داده<small>پاک‌سازی عادی دوباره اعمال می‌شود</small></span></button>
            @else
                <button class="act blue" data-dialog="dlg-hold">@icon('lock')<span>حفظ داده (توقیف)<small>هیچ چیزی از اتاق پاک نشود، حتی با حذف کاربر</small></span></button>
            @endif
            @if ($room->watched())
                <button class="act warn" data-dialog="dlg-unwatch">@icon('eye')<span>توقف ثبت اتصال<small>تا {{ $J->format($room->watch_until) }} فعال است</small></span></button>
            @else
                <button class="act warn" data-dialog="dlg-watch">@icon('eye')<span>ثبت اتصال‌ها (پایش)<small>زمان، IP و دستگاه هر اتصال، فقط برای این اتاق</small></span></button>
            @endif
        @endcan
        @can('rooms.moderate')
            <button class="act" data-dialog="dlg-kick">@icon('power')<span>قطع اتصال دستگاه‌ها<small>دوباره می‌توانند وصل شوند</small></span></button>
            @if ($room->suspended)
                <button class="act good" data-dialog="dlg-unsuspend">@icon('check')<span>رفع مسدودی</span></button>
            @else
                <button class="act danger" data-dialog="dlg-suspend">@icon('ban')<span>مسدود کردن اتاق<small>هیچ دستگاهی نتواند وارد شود</small></span></button>
            @endif
        @endcan
        @can('rooms.destroy')
            <button class="act" data-dialog="dlg-reset">@icon('refresh')<span>بازنشانی ثبت توکن<small>وقتی تاریخچه با رمز دیگری قفل شده</small></span></button>
            <button class="act danger" data-dialog="dlg-delete" @disabled($room->hold)>@icon('trash')<span>حذف کامل اتاق<small>{{ $room->hold ? 'در حالت توقیف ممکن نیست' : 'همه‌ی داده‌های رمزشده برای همیشه' }}</small></span></button>
        @endcan
    </div>

    {{-- dialogs --}}
    @php($noCase = $caseOptions->isEmpty())
    <dialog id="dlg-hold">
        <form method="post" action="{{ route('panel.rooms.hold', $room) }}">@csrf
            <div class="dlg-head"><span class="av blue t6">@icon('lock')</span><h2>حفظ داده (توقیف)</h2></div>
            <div class="dlg-body">
                <p>از این لحظه هیچ مورد ذخیره‌شده‌ای پاک نمی‌شود: حذف توسط کاربر، حذف خودکار، سقف حجم و سقف زمانی، مورد را به بخش «حفظ‌شده» منتقل می‌کنند. کاربران تغییری نمی‌بینند.</p>
                @include('panel.partials.case-select', ['required' => true])
                <div class="field"><label>توضیح</label><input class="input" name="reason" maxlength="300"></div>
            </div>
            <div class="dlg-foot"><button class="btn" @disabled($noCase)>فعال‌سازی توقیف</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-release">
        <form method="post" action="{{ route('panel.rooms.release', $room) }}">@csrf
            <div class="dlg-head"><span class="av t6">@icon('lock')</span><h2>برداشتن حفظ داده</h2></div>
            <div class="dlg-body"><p>موارد حفظ‌شده تا وقتی اتاق حذف نشود باقی می‌مانند، اما از این پس پاک‌سازی عادی اعمال می‌شود.</p>
                <div class="field"><label>دلیل (الزامی)</label><input class="input" name="reason" required maxlength="300"></div></div>
            <div class="dlg-foot"><button class="btn">برداشتن</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-watch">
        <form method="post" action="{{ route('panel.rooms.watch', $room) }}">@csrf
            <div class="dlg-head"><span class="av amber">@icon('eye')</span><h2>ثبت اتصال‌ها (پایش)</h2></div>
            <div class="dlg-body">
                <p>برای هر اتصال به همین اتاق، زمان، IP، کشور، شناسه‌ی دستگاه و مرورگر ثبت می‌شود؛ هیچ اتاق دیگری ثبت نمی‌شود و پس از مهلت خودکار خاموش می‌شود. محتوا همچنان رمزشده می‌ماند.</p>
                @include('panel.partials.case-select', ['required' => true])
                <div class="row2">
                    <div class="field"><label>مدت (روز)</label><input class="input" type="number" name="days" min="1" max="{{ config('najva.watch_max_days', 90) }}" value="30" required></div>
                    <div class="field"><label>مستند قانونی</label><input class="input" name="reason" required maxlength="300" placeholder="شماره‌ی دستور قضایی"></div>
                </div>
            </div>
            <div class="dlg-foot"><button class="btn" @disabled($noCase)>شروع پایش</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-unwatch">
        <form method="post" action="{{ route('panel.rooms.unwatch', $room) }}">@csrf
            <div class="dlg-head"><span class="av amber">@icon('eye')</span><h2>توقف ثبت اتصال</h2></div>
            <div class="dlg-body"><p>آنچه تا کنون ثبت شده در اتاق می‌ماند و در بسته‌ی افشا قابل استفاده است.</p></div>
            <div class="dlg-foot"><button class="btn">توقف</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-kick">
        <form method="post" action="{{ route('panel.rooms.kick', $room) }}">@csrf
            <div class="dlg-head"><span class="av gray">@icon('power')</span><h2>قطع اتصال</h2></div>
            <div class="dlg-body"><p>همه‌ی دستگاه‌های وصل به این اتاق قطع می‌شوند. اگر بخواهند، دوباره وصل می‌شوند؛ برای جلوگیری، اتاق را مسدود کنید.</p></div>
            <div class="dlg-foot"><button class="btn">قطع اتصال</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-suspend">
        <form method="post" action="{{ route('panel.rooms.suspend', $room) }}">@csrf
            <div class="dlg-head"><span class="av red">@icon('ban')</span><h2>مسدود کردن اتاق</h2></div>
            <div class="dlg-body">
                <p>دستگاه‌ها قطع می‌شوند و دیگر نمی‌توانند وارد شوند یا چیزی بفرستند. پیام «این اتاق به دستور مدیریت مسدود شده» به آن‌ها نشان داده می‌شود. داده‌ها پاک نمی‌شوند.</p>
                <div class="field"><label>دلیل (الزامی)</label><input class="input" name="reason" required maxlength="300"></div>
                @include('panel.partials.case-select', ['required' => false])
            </div>
            <div class="dlg-foot"><button class="btn danger">مسدود کن</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-unsuspend">
        <form method="post" action="{{ route('panel.rooms.unsuspend', $room) }}">@csrf
            <div class="dlg-head"><span class="av green">@icon('check')</span><h2>رفع مسدودی</h2></div>
            <div class="dlg-body"><div class="field"><label>دلیل (الزامی)</label><input class="input" name="reason" required maxlength="300"></div></div>
            <div class="dlg-foot"><button class="btn">رفع مسدودی</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-reset">
        <form method="post" action="{{ route('panel.rooms.reset', $room) }}">@csrf
            <div class="dlg-head"><span class="av gray">@icon('refresh')</span><h2>بازنشانی ثبت توکن</h2></div>
            <div class="dlg-body"><p>سرور فراموش می‌کند کدام دستگاه تاریخچه را ثبت کرده؛ نخستین دستگاهی که دوباره بنویسد، آن را با رمز خودش ثبت می‌کند. داده‌ها پاک نمی‌شوند.</p></div>
            <div class="dlg-foot"><button class="btn">بازنشانی</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
    <dialog id="dlg-delete">
        <form method="post" action="{{ route('panel.rooms.destroy', $room) }}" data-confirm="آخرین هشدار: حذف برگشت‌ناپذیر است. ادامه می‌دهید؟">@csrf
            <div class="dlg-head"><span class="av red">@icon('trash')</span><h2>حذف کامل اتاق</h2></div>
            <div class="dlg-body">
                <p>همه‌ی پیام‌ها و فایل‌های رمزشده‌ی این اتاق برای همیشه از سرور پاک می‌شوند و دستگاه‌ها قطع می‌شوند. اگر این اتاق موضوع یک درخواست قضایی است، به جای حذف «توقیف» کنید.</p>
                <div class="field"><label>برای تأیید، کد اتاق را بنویسید: <b>{{ $J->digits($room->code ?? $room->room_id) }}</b></label><input class="input" name="confirm" required autocomplete="off" inputmode="numeric"></div>
            </div>
            <div class="dlg-foot"><button class="btn danger">حذف برای همیشه</button><button type="button" class="btn ghost" data-close>انصراف</button></div>
        </form>
    </dialog>
@endsection
