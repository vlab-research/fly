<script>
    import { createEventDispatcher } from "svelte";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const required = field.validations.required;

    const dispatch = createEventDispatcher();

    const { properties } = field;

    const { steps } = properties;

    const arr = [];

    const count = () => {
        for (let i = 0; i < steps; i++) {
            arr.push(i);
        }
    };

    count();
</script>

<Title {field} />
<div class="mb-4 w-full">
    <div class="flex flex-row justify-between items-start">
        {#each arr as e, i}
            <div class="flex flex-col mr-2 sm:mr-4">
                <input
                    bind:group={fieldValue}
                    on:input={dispatch('add-field-value', fieldValue)}
                    id="label-{e}"
                    {required}
                    type="radio"
                    name="steps"
                    value={e}
                    class="mb-2" />
                <label for="label-{e}" class="text-sm md:text-lg">{e}</label>
            </div>
        {/each}
    </div>
</div>
