<script>
    import { createEventDispatcher } from "svelte";

    export let field, fieldValue, title;

    const { properties } = field;
    const { choices } = properties;

    const dispatch = createEventDispatcher();
</script>

<div class="space-y-0.5">
    <label
        for="field-{field.id}"
        class="text-2xl font-bold tracking-tight text-slate sm:text-3xl">{title}</label>
    {#each choices as choice, index (choice.id)}
        <div class="flex flex-row items-center">
            <input
                type="radio"
                name="choices"
                value={choice.label}
                bind={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)} />
            <label
                for="choice-{choice.label}"
                class="field-label">{choice.label}</label>
        </div>
    {/each}
</div>
