<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired, stepCount } from "../../../lib/typewheels/form.js";

    export let field, fieldValue, title;

    const dispatch = createEventDispatcher();

    const steps = field.properties.steps;

    const arr = [];

    const count = () => {
        for (let i = 0; i <= steps; i++) {
            arr.push(i);
        }
    };

    count();
</script>

<label
    for="field-{field.id}"
    class="text-2xl font-bold tracking-tight text-slate sm:text-xl whitespace-pre-line">{title}</label>
<div class="space-y-2.5 mb-2">
    <div class="flex flex-row items-center">
        {#each arr as e, index}
            <input
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)}
                required={field.validations.required ? setRequired : null}
                type="radio"
                name="steps"
                value={e}
                class="mr-2" />
            <label for="label-{e}" class="sm:text-xl">{index}</label>
        {/each}
    </div>
</div>
