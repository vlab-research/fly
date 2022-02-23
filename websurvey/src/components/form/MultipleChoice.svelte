<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired } from "../../../lib/typewheels/form.js";

    export let field, fieldValue, title;

    const { properties } = field;
    const { choices } = properties;

    const dispatch = createEventDispatcher();
</script>

<label
    for="field-{field.id}"
    class="text-2l font-bold tracking-tight text-slate sm:text-2xl">{title}</label>
<div class="space-y-2.5 mb-2">
    {#each choices as choice, index (choice.id)}
        <div class="flex flex-row items-center">
            <input
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)}
                required={field.validations.required ? setRequired : null}
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
