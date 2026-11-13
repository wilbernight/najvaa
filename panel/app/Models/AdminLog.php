<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\DB;

/**
 * Audit trail of admin activity. Never stores anything about chat users.
 *
 * Tamper-evident: each row carries hash = HMAC(app key, previous hash + the
 * row's own fields), so editing or deleting a row in the middle breaks every
 * hash after it, and nobody without the app key can rebuild the chain.
 * verifyChain() walks it and reports the first row that does not match.
 */
class AdminLog extends Model
{
    use Prunable;

    protected $table = 'admin_logs';

    public const UPDATED_AT = null;

    /** Persian label, icon and tone for each action (feeds, audit view). */
    public const LABELS = [
        'login' => ['ورود به پنل', 'key', 'green'], 'logout' => ['خروج از پنل', 'logout', ''], 'login.failed' => ['ورود ناموفق', 'alert', 'red'],
        'lockout' => ['قفل ورود پس از تلاش‌های ناموفق', 'lock', 'red'], 'password.changed' => ['تغییر رمز', 'key', 'blue'],
        'stepup.ok' => ['تأیید هویت دوباره', 'fingerprint', 'green'], 'stepup.failed' => ['تأیید هویت ناموفق', 'alert', 'red'], 'stepup.locked' => ['قفل تأیید هویت', 'lock', 'red'],
        'session.mismatch' => ['استفاده‌ی نشست از دستگاه دیگر', 'alert', 'red'], 'session.idle' => ['خروج خودکار (عدم فعالیت)', 'clock', ''], 'access.denied' => ['دسترسی رد شد', 'ban', 'red'],
        'room.lookup' => ['جستجوی اتاق با کد', 'search', ''], 'room.connlog.viewed' => ['مشاهده‌ی ثبت اتصال', 'globe', 'blue'],
        'room.hold' => ['توقیف (حفظ داده) اتاق', 'lock', 'blue'], 'room.released' => ['رفع توقیف', 'lock', ''], 'room.suspended' => ['مسدودی اتاق', 'ban', 'red'],
        'room.unsuspended' => ['رفع مسدودی اتاق', 'ban', ''], 'room.watch' => ['شروع پایش اتصال', 'eye', 'blue'], 'room.unwatch' => ['توقف پایش', 'eye', ''],
        'room.kicked' => ['قطع اتصال دستگاه‌ها', 'power', ''], 'room.reset' => ['بازنشانی توکن اتاق', 'refresh', ''], 'room.deleted' => ['حذف اتاق', 'trash', 'red'],
        'case.created' => ['ثبت پرونده', 'scale', 'green'], 'case.viewed' => ['مشاهده‌ی پرونده', 'scale', ''], 'case.updated' => ['به‌روزرسانی پرونده', 'scale', ''],
        'case.note' => ['یادداشت پرونده', 'chat', ''], 'case.room.attached' => ['افزودن اتاق به پرونده', 'link', ''], 'case.room.detached' => ['جدا کردن اتاق از پرونده', 'link', ''],
        'export.created' => ['ساخت بسته‌ی افشا', 'archive', 'blue'], 'export.downloaded' => ['دانلود بسته‌ی افشا', 'download', 'blue'], 'export.purged' => ['حذف بسته‌ی منقضی', 'trash', ''],
        'report.viewed' => ['مشاهده‌ی گزارش تخلف', 'flag', ''], 'report.updated' => ['رسیدگی به گزارش تخلف', 'flag', 'green'],
        'block.added' => ['مسدودی IP', 'shield', 'red'], 'block.removed' => ['رفع مسدودی IP', 'shield', ''],
        'notice.sent' => ['ارسال اعلان سراسری', 'megaphone', 'blue'], 'notice.cleared' => ['برداشتن اعلان سراسری', 'megaphone', ''],
        'settings.updated' => ['تغییر تنظیمات', 'gear', ''], 'domains.tls' => ['تغییر TLS دامنه', 'globe', ''], 'janitor.run' => ['پاک‌سازی دستی ذخیره‌گاه', 'refresh', ''],
        'store.janitor' => ['پاک‌سازی ذخیره‌گاه', 'refresh', ''], 'team.role' => ['تغییر نقش عضو تیم', 'users', 'blue'], 'team.sessions.ended' => ['بستن نشست‌های عضو تیم', 'users', ''],
        'audit.exported' => ['خروجی لاگ ممیزی', 'download', ''], 'audit.verified' => ['بررسی یکپارچگی لاگ', 'fingerprint', ''],
    ];

    /** @return array{0:string,1:string,2:string} */
    public static function label(string $action): array
    {
        return self::LABELS[$action] ?? [$action, 'info', ''];
    }

    protected $guarded = [];

    protected function casts(): array
    {
        return ['detail' => 'array', 'created_at' => 'datetime'];
    }

    /** Older than two years goes; the chain then starts at the oldest row left. */
    public function prunable(): Builder
    {
        return static::where('created_at', '<', now()->subYears(2));
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public static function record(string $action, ?string $target = null, array $detail = [], ?User $user = null, ?string $email = null): void
    {
        $user ??= auth()->user();
        $req = request();
        DB::transaction(function () use ($action, $target, $detail, $user, $email, $req) {
            $prev = static::query()->lockForUpdate()->orderByDesc('id')->value('hash');
            $row = new static([
                'user_id' => $user?->id,
                'email' => $email ?? $user?->email,
                'action' => $action,
                'target' => $target !== null ? mb_substr($target, 0, 120) : null,
                'detail' => $detail ?: null,
                'ip' => $req?->ip(),
                'ua' => $req ? mb_substr((string) $req->userAgent(), 0, 200) : null,
                'prev_hash' => $prev,
            ]);
            $row->created_at = now();
            $row->hash = $row->computeHash();
            $row->save();
        });
    }

    public function computeHash(): string
    {
        $payload = implode("\x1f", [
            (string) $this->prev_hash,
            $this->created_at?->format('Y-m-d H:i:s'),
            (string) $this->user_id,
            (string) $this->email,
            (string) $this->action,
            (string) $this->target,
            json_encode($this->detail, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            (string) $this->ip,
            (string) $this->ua,
        ]);

        return hash_hmac('sha256', $payload, 'najva-audit|'.config('app.key'));
    }

    /**
     * @return array{ok: bool, checked: int, broken: ?int, unhashed: int}
     */
    public static function verifyChain(): array
    {
        $prev = null;
        $first = true;
        $checked = 0;
        $unhashed = 0;
        foreach (static::query()->orderBy('id')->lazy(500) as $row) {
            if (! $row->hash) {   // rows written before the chain existed
                $unhashed++;

                continue;
            }
            if ((! $first && $row->prev_hash !== $prev) || ! hash_equals($row->hash, $row->computeHash())) {
                return ['ok' => false, 'checked' => $checked, 'broken' => $row->id, 'unhashed' => $unhashed];
            }
            $first = false;
            $prev = $row->hash;
            $checked++;
        }

        return ['ok' => true, 'checked' => $checked, 'broken' => null, 'unhashed' => $unhashed];
    }
}
