<?php

namespace App\Console\Commands;

use App\Models\AdminLog;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rules\Password;

/** Set a panel account's password over SSH (there are no reset emails). */
class NajvaPassword extends Command
{
    protected $signature = 'najva:password {email}';

    protected $description = 'Set the password of a panel account';

    public function handle(): int
    {
        $user = User::query()->where('email', strtolower($this->argument('email')))->first();
        if (! $user) {
            $this->error('No such account.');

            return self::FAILURE;
        }

        $password = (string) $this->secret('New password');
        if ($password !== (string) $this->secret('Repeat it')) {
            $this->error('The two passwords differ.');

            return self::FAILURE;
        }

        $v = Validator::make(['password' => $password], ['password' => ['required', Password::defaults()]]);
        if ($v->fails()) {
            foreach ($v->errors()->all() as $e) {
                $this->error($e);
            }

            return self::FAILURE;
        }

        $user->forceFill(['password' => $password, 'remember_token' => null])->save();
        AdminLog::record('password.changed', 'ssh', [], $user);
        $this->info('Password changed.');

        return self::SUCCESS;
    }
}
