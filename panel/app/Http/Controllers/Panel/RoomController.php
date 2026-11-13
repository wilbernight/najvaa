<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Models\LegalCase;
use App\Models\LegalCaseRoom;
use App\Models\Room;
use App\Services\Relay;
use App\Support\Jalali;
use Closure;
use Illuminate\Http\Client\RequestException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Throwable;

class RoomController extends Controller
{
    public function __construct(private Relay $relay) {}

    /** The list pane (shared with the room page). */
    public static function list(Request $request)
    {
        $q = Jalali::latin(trim((string) $request->query('q', '')));
        $filter = (string) $request->query('f', 'all');

        return Room::query()
            ->when($q !== '', fn ($b) => $b->where(fn ($w) => $w->where('code', 'like', "%{$q}%")->orWhere('room_id', 'like', "{$q}%")))
            ->when($filter === 'online', fn ($b) => $b->where('online', '>', 0))
            ->when($filter === 'held', fn ($b) => $b->where('hold', true))
            ->when($filter === 'suspended', fn ($b) => $b->where('suspended', true))
            ->when($filter === 'watched', fn ($b) => $b->where('watch_until', '>', now()))
            ->when($filter === 'big', fn ($b) => $b->where('bytes', '>', 100 * 1048576))
            ->orderByDesc('online')
            ->orderByRaw('last_activity_at is null')
            ->orderByDesc('last_activity_at')
            ->limit(300)
            ->get();
    }

    public function index(Request $request)
    {
        return view('panel.rooms.index', ['rooms' => self::list($request)]);
    }

    /** Find a room by its 7-digit code, even one the panel has not mirrored yet. */
    public function find(Request $request)
    {
        $code = Jalali::latin(trim((string) $request->query('code', '')));
        if (! preg_match('/^\d{7}$/', $code)) {
            return back()->withErrors(['code' => 'کد اتاق باید ۷ رقم باشد.']);
        }
        $id = Room::idForCode($code);
        AdminLog::record('room.lookup', $code);
        $room = Room::query()->where('room_id', $id)->first();
        if (! $room) {
            try {
                $meta = $this->relay->roomMeta($id);
            } catch (Throwable) {
                return back()->withErrors(['code' => 'سرویس چت پاسخ نمی‌دهد.']);
            }
            if (! $meta) {
                return back()->withErrors(['code' => 'اتاقی با این کد روی سرور نیست (هرگز ساخته نشده یا پاک شده است).']);
            }
            $room = Room::query()->create(['room_id' => $id, 'code' => $code, 'stored' => true, 'items' => count($meta['entries']), 'bytes' => $meta['bytes']]);
        }
        $room->code ??= $code;
        $room->save();

        return redirect()->route('panel.rooms.show', $room);
    }

    public function show(Request $request, Room $room)
    {
        $meta = null;
        $error = null;
        try {
            $meta = $this->relay->roomMeta($room->room_id);
        } catch (Throwable) {
            $error = 'سرویس چت پاسخ نمی‌دهد؛ اطلاعات زنده در دسترس نیست.';
        }
        $canLegal = Gate::allows('legal.view');
        if ($canLegal && $meta && ! empty($meta['conn'])) {
            AdminLog::record('room.connlog.viewed', $room->label, ['events' => count($meta['conn'])]);
        }

        // Timeline: stored items grouped by day, newest day last (like a chat).
        $timeline = collect($meta['entries'] ?? [])->map(fn ($e) => $e + ['state' => 'live'])
            ->concat(collect($meta['held'] ?? [])->map(fn ($e) => $e + ['state' => 'held']))
            ->sortBy('ts')->values()
            ->groupBy(fn ($e) => Jalali::format($e['ts'], 'j F Y'));

        return view('panel.rooms.show', [
            'rooms' => self::list($request),
            'room' => $room,
            'meta' => $meta,
            'error' => $error,
            'timeline' => $timeline,
            'conn' => $canLegal ? array_reverse($meta['conn'] ?? []) : [],
            'links' => LegalCaseRoom::query()->with('legalCase')->where('room_id', $room->room_id)->get(),
            'openCases' => $canLegal ? LegalCase::query()->whereIn('status', LegalCase::OPEN)->latest()->limit(100)->get() : collect(),
        ]);
    }

    public function kick(Room $room)
    {
        return $this->act($room, 'room.kicked', fn () => $this->relay->kickRoom($room->room_id), 'اتصال دستگاه‌های اتاق قطع شد.');
    }

    public function suspend(Request $request, Room $room)
    {
        $data = $request->validate(['reason' => ['required', 'string', 'max:300'], 'case_id' => ['nullable', 'integer', 'exists:legal_cases,id']]);
        $case = $this->caseFor($data['case_id'] ?? null, $room);

        return $this->act($room, 'room.suspended', function () use ($room, $data, $case) {
            $this->relay->setFlags($room->room_id, ['suspend' => ['case' => $case?->ref, 'by' => auth()->user()->email, 'reason' => $data['reason']]]);
            $room->update(['suspended' => true, 'online' => 0]);
            $case?->log('suspend', $data['reason'], ['room' => $room->label]);
        }, 'اتاق مسدود شد؛ هیچ دستگاهی نمی‌تواند وارد شود.', ['reason' => $data['reason'], 'case' => $case?->ref]);
    }

    public function unsuspend(Request $request, Room $room)
    {
        $reason = (string) $request->validate(['reason' => ['required', 'string', 'max:300']])['reason'];

        return $this->act($room, 'room.unsuspended', function () use ($room, $reason) {
            $this->relay->setFlags($room->room_id, ['suspend' => null]);
            $room->update(['suspended' => false]);
            $this->logCases($room, 'unsuspend', $reason);
        }, 'مسدودی اتاق برداشته شد.', ['reason' => $reason]);
    }

    public function hold(Request $request, Room $room)
    {
        $data = $request->validate(['case_id' => ['required', 'integer', 'exists:legal_cases,id'], 'reason' => ['nullable', 'string', 'max:300']]);
        $case = $this->caseFor($data['case_id'], $room);

        return $this->act($room, 'room.hold', function () use ($room, $case, $data) {
            $this->relay->setFlags($room->room_id, ['hold' => ['case' => $case->ref, 'by' => auth()->user()->email, 'reason' => (string) ($data['reason'] ?? '')]]);
            $room->update(['hold' => true]);
            $case->log('hold', $data['reason'] ?? null, ['room' => $room->label]);
        }, 'حفظ داده (توقیف) فعال شد: از این لحظه هیچ چیزی از این اتاق پاک نمی‌شود.', ['case' => $case->ref]);
    }

    public function release(Request $request, Room $room)
    {
        $reason = (string) $request->validate(['reason' => ['required', 'string', 'max:300']])['reason'];

        return $this->act($room, 'room.released', function () use ($room, $reason) {
            $this->relay->setFlags($room->room_id, ['hold' => null]);
            $room->update(['hold' => false]);
            $this->logCases($room, 'release', $reason);
        }, 'حفظ داده برداشته شد؛ پاک‌سازی عادی دوباره اعمال می‌شود.', ['reason' => $reason]);
    }

    public function watch(Request $request, Room $room)
    {
        $max = (int) config('najva.watch_max_days', 90);
        $data = $request->validate([
            'case_id' => ['required', 'integer', 'exists:legal_cases,id'],
            'days' => ['required', 'integer', 'min:1', "max:{$max}"],
            'reason' => ['required', 'string', 'max:300'],
        ]);
        $case = $this->caseFor($data['case_id'], $room);
        $until = now()->addDays((int) $data['days']);

        return $this->act($room, 'room.watch', function () use ($room, $case, $data, $until) {
            $this->relay->setFlags($room->room_id, ['watch' => [
                'case' => $case->ref, 'by' => auth()->user()->email, 'reason' => $data['reason'], 'until' => $until->getTimestampMs(),
            ]]);
            $room->update(['watch_until' => $until]);
            $case->log('watch', $data['reason'], ['room' => $room->label, 'until' => $until->toIso8601String()]);
        }, 'ثبت اتصال‌های این اتاق تا '.Jalali::format($until).' فعال شد.', ['case' => $case->ref, 'days' => (int) $data['days']]);
    }

    public function unwatch(Request $request, Room $room)
    {
        return $this->act($room, 'room.unwatch', function () use ($room) {
            $this->relay->setFlags($room->room_id, ['watch' => null]);
            $room->update(['watch_until' => null]);
            $this->logCases($room, 'unwatch', null);
        }, 'ثبت اتصال‌ها متوقف شد. آنچه تا کنون ثبت شده، نگه داشته می‌شود.');
    }

    public function reset(Room $room)
    {
        return $this->act($room, 'room.reset', fn () => $this->relay->resetRoom($room->room_id), 'ثبت توکن اتاق بازنشانی شد.');
    }

    public function destroy(Request $request, Room $room)
    {
        $request->validate(['confirm' => ['required', 'string']]);
        if (Jalali::latin(trim((string) $request->input('confirm'))) !== ($room->code ?? $room->room_id)) {
            return back()->withErrors(['confirm' => 'برای حذف، کد اتاق را دقیقاً وارد کنید.']);
        }
        if ($room->hold) {
            return back()->withErrors(['confirm' => 'این اتاق تحت حفظ داده (توقیف) است و حذف نمی‌شود.']);
        }
        try {
            $this->relay->deleteRoom($room->room_id);
        } catch (RequestException $e) {
            return back()->withErrors(['confirm' => $e->response->status() === 409 ? 'این اتاق تحت حفظ داده است و حذف نمی‌شود.' : 'سرویس چت خطا داد.']);
        } catch (Throwable) {
            return back()->withErrors(['confirm' => 'سرویس چت پاسخ نداد؛ اتاق حذف نشد.']);
        }
        AdminLog::record('room.deleted', $room->label, ['items' => $room->items, 'bytes' => $room->bytes]);
        $this->logCases($room, 'note', 'اتاق '.$room->label.' به‌طور کامل حذف شد.');
        $room->delete();

        return redirect()->route('panel.rooms')->with('panel.flash', 'اتاق و همه‌ی داده‌های رمزشده‌اش حذف شد.');
    }

    public function janitor()
    {
        try {
            $r = $this->relay->runJanitor();
        } catch (Throwable) {
            return back()->withErrors(['janitor' => 'سرویس چت پاسخ نداد.']);
        }
        AdminLog::record('janitor.run', null, $r);

        return back()->with('panel.flash', 'پاک‌سازی انجام شد. حجم فعلی: '.Jalali::bytes($r['totalBytes'] ?? 0));
    }

    /** Runs a relay call, writes the audit line, and reports back to the page. */
    private function act(Room $room, string $action, Closure $call, string $ok, array $detail = [])
    {
        try {
            $call();
        } catch (Throwable $e) {
            report($e);

            return back()->withErrors(['relay' => 'سرویس چت پاسخ نداد؛ کاری انجام نشد.']);
        }
        AdminLog::record($action, $room->label, $detail);

        return back()->with('panel.flash', $ok);
    }

    /** The case named in the form; the room is linked to it if it was not. */
    private function caseFor(?int $id, Room $room): ?LegalCase
    {
        if (! $id) {
            return null;
        }
        $case = LegalCase::query()->findOrFail($id);
        $link = LegalCaseRoom::query()->firstOrCreate(
            ['legal_case_id' => $case->id, 'room_id' => $room->room_id],
            ['code' => $room->code, 'added_by' => auth()->id()]
        );
        if ($link->wasRecentlyCreated) {
            $case->log('room', null, ['room' => $room->label, 'added' => true]);
        }

        return $case;
    }

    private function logCases(Room $room, string $kind, ?string $body): void
    {
        LegalCase::query()->whereIn('id', LegalCaseRoom::query()->where('room_id', $room->room_id)->select('legal_case_id'))
            ->get()->each(fn (LegalCase $c) => $c->log($kind, $body, ['room' => $room->label]));
    }
}
