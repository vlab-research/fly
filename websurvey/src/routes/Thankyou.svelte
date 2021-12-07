<script>
    import { getThankyouScreen } from "../../lib/typewheels/form";
    export let form;

    const thankyouScreen = getThankyouScreen(form, 0);
    const { title } = thankyouScreen;
</script>

<div class="surveyapp stack-large">
    <div class="stack-small">
        <h1 class="label-wrapper">{title}</h1>
    </div>
</div>
