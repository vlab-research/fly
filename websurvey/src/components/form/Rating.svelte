<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired } from "../../../lib/typewheels/form.js";

    export let field, fieldValue, title;

    const { properties } = field;

    const dispatch = createEventDispatcher();

    const { steps } = properties;

    const arr = [];

    const count = () => {
        for (let i = 0; i < steps; i++) {
            arr.push(i);
        }
    };

    count();
</script>

<label
    for="field-{field.id}"
    class="text-2xl font-bold tracking-tight text-slate sm:text-xl whitespace-pre-line">{title}</label>
<div class="space-y-2.5 mb-2">
    <div class="flex flex-row justify-between items-start mb-2">
        {#each arr as e, index}
            <div class="flex flex-col mr-4">
                <input
                    bind:group={fieldValue}
                    on:input={dispatch('add-field-value', fieldValue)}
                    required={field.validations.required ? setRequired : null}
                    type="radio"
                    name="steps"
                    value={e}
                    class="mr-2 mb-2" />
                <label for="label-{e}" class="sm:text-xl mr-2">{index}</label>
            </div>
        {/each}
    </div>
</div>
