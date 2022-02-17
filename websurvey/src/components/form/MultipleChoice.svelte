<script>
    import { createEventDispatcher } from "svelte";

    export let field, fieldValue, title;

    const { properties } = field;
    const { choices } = properties;

    const dispatch = createEventDispatcher();
</script>

<label
    for="field-{field.id}"
    class="text-2xl font-bold tracking-tight text-slate sm:text-3xl mb-2">{title}</label>
<div class="space-y-2.5 mb-2">
    {#each choices as choice, index (choice.id)}
        <div class="flex flex-row items-center">
            <input
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)}
                type="radio"
                name="choices"
                value={choice.label}
                class="mr-2" />
            <label
                for="choice-{choice.label}"
                class="sm:text-xl">{choice.label}</label>
        </div>
    {/each}
</div>
