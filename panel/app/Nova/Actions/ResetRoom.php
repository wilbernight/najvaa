<?php

namespace App\Nova\Actions;

use App\Models\AdminLog;
use App\Services\Relay;
use Illuminate\Support\Collection;
use Laravel\Nova\Actions\Action;
use Laravel\Nova\Actions\ActionResponse;
use Laravel\Nova\Fields\ActionFields;
use Laravel\Nova\Http\Requests\NovaRequest;
use Throwable;

/**
 * Unlocks a room's stored history. The relay only records a hash of the token
 * derived from the room password that wrote first; if a different password
 * claimed it, the real owner's devices can read neither history nor write new
 * entries. This drops that registration and nothing else: every encrypted
 * message and file stays exactly as it is, and the legitimate devices
 * re-register on their next write.
 */
class ResetRoom extends Action
{
    public function name(): string
    {
        return 'بازنشانی ثبت اتاق';
    }

    public function __construct()
    {
        $this->confirmText('ثبتِ تاریخچه‌ی این اتاق بازنشانی می‌شود؛ هیچ پیام یا فایلی پاک نمی‌شود. دستگاه‌هایی که رمز درست را دارند از این پس می‌توانند تاریخچه را بخوانند و بنویسند. اگر دستگاه‌های خودتان وصل‌اند، یک‌بار خارج و وارد شوند.')
            ->confirmButtonText('بازنشانی ثبت')
            ->cancelButtonText('انصراف');
    }

    public function fields(NovaRequest $request): array
    {
        return [];
    }

    public function handle(ActionFields $fields, Collection $models)
    {
        $done = 0;
        foreach ($models as $room) {
            try {
                if (app(Relay::class)->resetRoom($room->room_id)) {
                    $done++;
                }
            } catch (Throwable) {
                return ActionResponse::danger('سرویس چت پاسخ نداد؛ ثبتی بازنشانی نشد.');
            }
            AdminLog::record('room.reset', $room->code ?? $room->short_id, ['items' => $room->items, 'bytes' => $room->bytes]);
        }

        return ActionResponse::message($done
            ? "ثبت {$done} اتاق بازنشانی شد. پیام‌های رمزشده دست‌نخورده مانده‌اند."
            : 'چیزی برای بازنشانی نبود.');
    }
}
