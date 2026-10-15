<?php

use Illuminate\Support\Facades\Schedule;

// Panel data refresh. Run by the server's cron: `php artisan schedule:run` every minute.
Schedule::command('najva:sync')->everyMinute()->withoutOverlapping();
Schedule::command('najva:health')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('najva:domains')->everyThirtyMinutes()->withoutOverlapping();
Schedule::command('najva:codes')->everyMinute()->withoutOverlapping(10);
Schedule::command('model:prune', ['--model' => [\App\Models\AdminLog::class]])->daily();
