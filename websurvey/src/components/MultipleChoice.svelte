<script>
    import { createEventDispatcher } from "svelte";
    import { ResponseStore } from "../../lib/typewheels/responseStore.js";

    export let field, fieldValue, qa;

    const responseStore = new ResponseStore();

    const { properties } = field;
    const { choices } = properties;

    const dispatch = createEventDispatcher();

    const title = responseStore.interpolationCheck(field, qa);
</script>

<div>
    <label for="field-{field.id}" class="field-label">{title}</label>
    {#each choices as choice, index (choice.id)}
        <div class="c-cb">
            <input
                type="radio"
                name="choices"
                value={choice.label}
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)} />
            <label
                for="choice-{choice.label}"
                class="field-label">{choice.label}</label>
        </div>
    {/each}
</div>
