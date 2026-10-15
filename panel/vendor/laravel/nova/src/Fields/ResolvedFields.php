<?php

namespace Laravel\Nova\Fields;

use Illuminate\Support\Collection;
use Illuminate\Support\Fluent;

/**
 * @extends \Illuminate\Support\Fluent<array-key, mixed>
 */
class ResolvedFields extends Fluent
{
    /**
     * The post-storage callbacks for the fields.
     *
     * @var \Illuminate\Support\Collection
     */
    public $callbacks;

    /**
     * Create a new resolved fields instance.
     */
    public function __construct(Collection $attributes, Collection $callbacks)
    {
        parent::__construct($attributes->all());

        $this->callbacks = $callbacks;
    }

    /**
     * Get the post-storage callbacks for the fields.
     */
    public function callbacks(): Collection
    {
        return $this->callbacks;
    }
}
