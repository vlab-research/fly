<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired, ariaRequired } from "../../../lib/typewheels/form.js";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const required = field.validations.required;

    const dispatch = createEventDispatcher();

    const { properties } = field;

    const { steps } = properties;

    const arr = [];

    const startAtOne = field.properties.start_at_one;

    const count = () => {
        let index = startAtOne ? 1 : 0;
        for (let i = index; startAtOne ? i <= steps : i < steps; i++) {
            arr.push(i);
        }
    };

    count();
</script>

<Title {field} />
<div class="space-y-2.5 mb-2 w-full">
    <div class="flex flex-row justify-between items-start mb-2">
        {#each arr as e, i}
            <div class="flex flex-col mr-2 sm:mr-4">
                <input
                    bind:group={fieldValue}
                    on:input={dispatch('add-field-value', fieldValue)}
                    id="label-{e}"
                    required={required ? setRequired : null}
                    aria-required={ariaRequired(required)}
                    type="radio"
                    name="steps"
                    value={e}
                    class="mb-2" />
                <label for="label-{e}" class="text-sm sm:text-xl">{e}</label>
            </div>
        {/each}
    </div>
</div>
