<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Models\LegalCase;
use App\Models\LegalCaseRoom;
use App\Models\Room;
use App\Models\User;
use App\Support\Jalali;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class CaseController extends Controller
{
    public static function list(Request $request)
    {
        $f = (string) $request->query('f', 'open');
        $q = trim((string) $request->query('q', ''));

        return LegalCase::query()->with('rooms')
            ->when($f === 'open', fn ($b) => $b->whereIn('status', LegalCase::OPEN))
            ->when($f === 'overdue', fn ($b) => $b->whereIn('status', LegalCase::OPEN)->whereDate('due_on', '<', today()))
            ->when($f === 'mine', fn ($b) => $b->where('assignee_id', auth()->id()))
            ->when($f === 'closed', fn ($b) => $b->whereNotIn('status', LegalCase::OPEN))
            ->orderByRaw("case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end")
            ->latest('updated_at')
            ->limit(300)
            ->get()
            // Subject and authority are encrypted, so search happens after decrypting.
            ->when($q !== '', fn ($c) => $c->filter(fn (LegalCase $x) => str_contains(mb_strtolower($x->ref.' '.$x->subject.' '.$x->authority.' '.$x->authority_ref), mb_strtolower($q))
                || $x->rooms->contains(fn ($r) => $r->code === Jalali::latin($q))));
    }

    public function index(Request $request)
    {
        return view('panel.cases.index', ['cases' => self::list($request)]);
    }

    public function create(Request $request)
    {
        return view('panel.cases.create', [
            'cases' => self::list($request),
            'users' => User::query()->orderBy('name')->get(),
            'prefillCode' => Jalali::latin((string) $request->query('code', '')),
        ]);
    }

    public function store(Request $request)
    {
        $data = $this->validated($request, true);
        $case = LegalCase::query()->create($data + ['ref' => LegalCase::nextRef(), 'created_by' => auth()->id(), 'status' => 'received']);
        $case->log('status', null, ['status' => 'received']);
        AdminLog::record('case.created', $case->ref, ['kind' => $case->kind]);

        foreach (preg_split('/[\s,،]+/', Jalali::latin((string) $request->input('codes', ''))) as $code) {
            if (preg_match('/^\d{7}$/', $code)) {
                $this->link($case, $code);
            }
        }

        return redirect()->route('panel.cases.show', $case)->with('panel.flash', 'پرونده '.$case->ref.' ثبت شد.');
    }

    public function show(Request $request, LegalCase $case)
    {
        AdminLog::record('case.viewed', $case->ref);
        $case->load(['events.user', 'rooms.room', 'exports.creator', 'assignee']);

        return view('panel.cases.show', [
            'cases' => self::list($request),
            'case' => $case,
            'users' => User::query()->orderBy('name')->get(),
            'days' => $case->events->groupBy(fn ($e) => Jalali::format($e->created_at, 'j F Y')),
        ]);
    }

    public function update(Request $request, LegalCase $case)
    {
        $data = $this->validated($request, false);
        $before = $case->only(['status', 'priority', 'assignee_id', 'due_on']);
        if (isset($data['status']) && $data['status'] !== $case->status) {
            $data['closed_at'] = in_array($data['status'], LegalCase::OPEN, true) ? null : now();
        }
        $case->fill($data);
        $dirty = array_keys($case->getDirty());
        $case->save();

        if ($case->wasChanged('status')) {
            $case->log('status', $request->input('status_note') ?: null, ['from' => $before['status'], 'status' => $case->status]);
        }
        if ($case->wasChanged('assignee_id')) {
            $case->log('note', 'مسئول پرونده: '.($case->assignee?->name ?? '—'));
        }
        AdminLog::record('case.updated', $case->ref, ['fields' => $dirty]);

        return back()->with('panel.flash', 'پرونده به‌روز شد.');
    }

    public function note(Request $request, LegalCase $case)
    {
        $body = (string) $request->validate(['body' => ['required', 'string', 'max:5000']])['body'];
        $case->log('note', $body);
        $case->touch();
        AdminLog::record('case.note', $case->ref);

        return redirect()->to(route('panel.cases.show', $case).'#end');
    }

    public function attachRoom(Request $request, LegalCase $case)
    {
        $code = Jalali::latin(trim((string) $request->input('code')));
        if (! preg_match('/^\d{7}$/', $code)) {
            return back()->withErrors(['code' => 'کد اتاق باید ۷ رقم باشد.']);
        }
        $this->link($case, $code);

        return back()->with('panel.flash', 'اتاق '.Jalali::digits($code).' به پرونده افزوده شد.');
    }

    public function detachRoom(LegalCase $case, LegalCaseRoom $link)
    {
        abort_unless($link->legal_case_id === $case->id, 404);
        if ($link->room?->hold || $link->room?->watched()) {
            return back()->withErrors(['code' => 'ابتدا حفظ داده یا پایش این اتاق را بردارید.']);
        }
        $case->log('room', null, ['room' => $link->label, 'removed' => true]);
        AdminLog::record('case.room.detached', $case->ref, ['room' => $link->label]);
        $link->delete();

        return back()->with('panel.flash', 'اتاق از پرونده جدا شد.');
    }

    private function link(LegalCase $case, string $code): void
    {
        $id = Room::idForCode($code);
        $link = LegalCaseRoom::query()->firstOrCreate(['legal_case_id' => $case->id, 'room_id' => $id], ['code' => $code, 'added_by' => auth()->id()]);
        if ($link->wasRecentlyCreated) {
            $case->log('room', null, ['room' => $code, 'added' => true, 'exists' => Room::query()->where('room_id', $id)->exists()]);
            AdminLog::record('case.room.attached', $case->ref, ['room' => $code]);
        }
    }

    private function validated(Request $request, bool $creating): array
    {
        $req = $creating ? 'required' : 'sometimes';
        $data = $request->validate([
            'kind' => [$req, Rule::in(array_keys(LegalCase::KINDS))],
            'priority' => [$req, Rule::in(array_keys(LegalCase::PRIORITIES))],
            'status' => ['sometimes', Rule::in(array_keys(LegalCase::STATUSES))],
            'authority' => [$req, 'string', 'max:300'],
            'authority_ref' => ['nullable', 'string', 'max:120'],
            'subject' => [$req, 'string', 'max:300'],
            'description' => ['nullable', 'string', 'max:10000'],
            'received_on' => [$req, 'string', 'max:12'],
            'due_on' => ['nullable', 'string', 'max:12'],
            'assignee_id' => ['nullable', 'integer', 'exists:users,id'],
        ]);
        foreach (['received_on', 'due_on'] as $f) {
            if (! array_key_exists($f, $data)) {
                continue;
            }
            if ($data[$f] === null || $data[$f] === '') {
                $data[$f] = null;

                continue;
            }
            $d = Jalali::parse($data[$f]);
            if (! $d) {
                throw \Illuminate\Validation\ValidationException::withMessages([$f => 'تاریخ را به شکل ۱۴۰۵/۰۸/۲۲ وارد کنید.']);
            }
            $data[$f] = $d->toDateString();
        }
        if ($creating && empty($data['received_on'])) {
            $data['received_on'] = today()->toDateString();
        }

        return $data;
    }
}
